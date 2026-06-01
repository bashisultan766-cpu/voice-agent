import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { detectPhoneCountry } from '../../config/smsCountryRules';
import { buildPaymentEmailContent } from '../integrations/email/payment-email-templates';
import { EmailDeliveryService } from './email-delivery.service';
import { TwilioPaymentSmsService } from './twilio-payment-sms.service';
import { TwilioWhatsAppService } from './twilio-whatsapp.service';
import { InboundCallCaptureService } from './inbound-call-capture.service';
import {
  buildAgentDeliveryMessage,
  type DeliveryChannelResult,
  type PaymentLinkDeliveryResult,
} from './utils/agent-delivery-message.util';

export type DeliverPaymentLinkInput = {
  customerEmail: string;
  customerPhone?: string | null;
  paymentLink: string;
  callSid?: string | null;
  orderId?: string | null;
  tenantId?: string;
  agentId?: string;
  businessName?: string;
  supportEmail?: string | null;
  supportPhone?: string | null;
  lineItems?: Array<{ title: string; quantity: number; price?: string | null }>;
};

export type DeliverPaymentLinkOutput = PaymentLinkDeliveryResult & {
  agentMessage: string;
  emailMessageId?: string;
  emailError?: string;
  smsMessageSid?: string;
  smsError?: string;
  whatsappMessageSid?: string;
  whatsappError?: string;
  deliveryId: string;
};

@Injectable()
export class PaymentLinkDeliveryService {
  private readonly logger = new Logger(PaymentLinkDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailDelivery: EmailDeliveryService,
    private readonly sms: TwilioPaymentSmsService,
    private readonly whatsapp: TwilioWhatsAppService,
    private readonly inboundCalls: InboundCallCaptureService,
  ) {}

  async deliverPaymentLink(input: DeliverPaymentLinkInput): Promise<DeliverPaymentLinkOutput> {
    const customerEmail = input.customerEmail.trim().toLowerCase();
    const paymentLink = input.paymentLink.trim();

    let customerPhone = input.customerPhone?.trim() || null;
    if (!customerPhone && input.callSid) {
      customerPhone = await this.inboundCalls.findCallerPhoneByCallSid(input.callSid);
    }

    const country =
      (customerPhone ? detectPhoneCountry(customerPhone) : null) ??
      (input.callSid
        ? (
            await this.prisma.inboundCall.findUnique({
              where: { callSid: input.callSid },
              select: { callerCountry: true },
            })
          )?.callerCountry ?? null
        : null);

    const deliveryRow = await this.prisma.paymentDelivery.create({
      data: {
        callSid: input.callSid ?? null,
        orderId: input.orderId ?? null,
        customerEmail,
        customerPhone,
        country,
        paymentLink,
        emailStatus: 'pending',
        smsStatus: customerPhone ? 'pending' : 'skipped',
        whatsappStatus: customerPhone && this.whatsapp.isEnabled() ? 'pending' : 'skipped',
      },
    });

    const result: PaymentLinkDeliveryResult = {
      email: 'failed',
      sms: customerPhone ? 'failed' : 'skipped',
      whatsapp: customerPhone && this.whatsapp.isEnabled() ? 'failed' : 'skipped',
    };

    let emailMessageId: string | undefined;
    let emailError: string | undefined;
    let smsMessageSid: string | undefined;
    let smsError: string | undefined;
    let whatsappMessageSid: string | undefined;
    let whatsappError: string | undefined;

    // 1. Email (primary channel)
    const tmpl = buildPaymentEmailContent({
      businessName: input.businessName?.trim() || 'SureShot Books',
      supportEmail: input.supportEmail,
      supportPhone: input.supportPhone,
      checkoutUrl: paymentLink,
      items: input.lineItems ?? [{ title: 'Your order', quantity: 1, price: null }],
    });

    const emailResult = await this.emailDelivery.sendPaymentLinkEmail({
      to: customerEmail,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
      replyTo: input.supportEmail,
    });

    if (emailResult.ok) {
      result.email = 'sent';
      emailMessageId = emailResult.messageId;
    } else {
      result.email = 'failed';
      emailError = emailResult.error;
    }

    await this.prisma.paymentDelivery.update({
      where: { id: deliveryRow.id },
      data: {
        emailStatus: result.email,
        emailMessageId: emailMessageId ?? null,
        emailError: emailError?.slice(0, 500) ?? null,
      },
    });

    // 2. SMS (bonus — never throws)
    if (customerPhone) {
      try {
        const smsResult = await this.sms.sendSmsPaymentLink({
          phone: customerPhone,
          paymentLink,
          tenantId: input.tenantId,
          agentId: input.agentId,
        });
        result.sms = smsResult.status;
        smsMessageSid = smsResult.messageSid;
        smsError = smsResult.error;
      } catch (err) {
        result.sms = 'failed';
        smsError = err instanceof Error ? err.message : String(err);
        this.logger.warn(JSON.stringify({ event: 'sms_failed', deliveryId: deliveryRow.id, smsError }));
      }
    }

    await this.prisma.paymentDelivery.update({
      where: { id: deliveryRow.id },
      data: {
        smsStatus: result.sms,
        smsMessageSid: smsMessageSid ?? null,
        smsError: smsError?.slice(0, 500) ?? null,
      },
    });

    // 3. WhatsApp (bonus — after email)
    if (customerPhone && this.whatsapp.isEnabled()) {
      try {
        const waResult = await this.whatsapp.sendWhatsAppPaymentLink({
          phone: customerPhone,
          paymentLink,
          tenantId: input.tenantId,
          agentId: input.agentId,
        });
        result.whatsapp = waResult.status;
        whatsappMessageSid = waResult.messageSid;
        whatsappError = waResult.error;
      } catch (err) {
        result.whatsapp = 'failed';
        whatsappError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          JSON.stringify({ event: 'whatsapp_failed', deliveryId: deliveryRow.id, whatsappError }),
        );
      }
    }

    await this.prisma.paymentDelivery.update({
      where: { id: deliveryRow.id },
      data: {
        whatsappStatus: result.whatsapp,
        whatsappMessageSid: whatsappMessageSid ?? null,
        whatsappError: whatsappError?.slice(0, 500) ?? null,
      },
    });

    const agentMessage = buildAgentDeliveryMessage(result);

    this.logger.log(
      JSON.stringify({
        event: 'payment_link_delivery_completed',
        deliveryId: deliveryRow.id,
        callSid: input.callSid ?? null,
        orderId: input.orderId ?? null,
        email: result.email,
        sms: result.sms,
        whatsapp: result.whatsapp,
      }),
    );

    return {
      ...result,
      agentMessage,
      deliveryId: deliveryRow.id,
      emailMessageId,
      emailError,
      smsMessageSid,
      smsError,
      whatsappMessageSid,
      whatsappError,
    };
  }
}
