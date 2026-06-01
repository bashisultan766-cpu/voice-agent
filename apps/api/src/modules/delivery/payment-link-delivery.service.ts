import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { detectPhoneCountry } from '../../config/smsCountryRules';
import { buildPaymentEmailContent } from '../integrations/email/payment-email-templates';
import { AgentEmailConfigService } from '../integrations/email/agent-email-config.service';
import { EmailDeliveryService } from './email-delivery.service';
import { TwilioPaymentSmsService } from './twilio-payment-sms.service';
import { TwilioWhatsAppService } from './twilio-whatsapp.service';
import { InboundCallCaptureService } from './inbound-call-capture.service';
import {
  buildAgentDeliveryMessage,
  type DeliveryChannelResult,
  type PaymentLinkDeliveryResult,
} from './utils/agent-delivery-message.util';
import { logDelivery, logDeliveryError, logDeliveryWarn } from './utils/delivery-logger.util';

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
    private readonly config: ConfigService,
    private readonly emailDelivery: EmailDeliveryService,
    private readonly agentEmailConfig: AgentEmailConfigService,
    private readonly sms: TwilioPaymentSmsService,
    private readonly whatsapp: TwilioWhatsAppService,
    private readonly inboundCalls: InboundCallCaptureService,
  ) {}

  async deliverPaymentLink(input: DeliverPaymentLinkInput): Promise<DeliverPaymentLinkOutput> {
    const customerEmail = input.customerEmail.trim().toLowerCase();
    const paymentLink = input.paymentLink.trim();
    const callSid = input.callSid?.trim() || null;

    let customerPhone = input.customerPhone?.trim() || null;
    const phoneFromRequest = Boolean(customerPhone);

    if (!customerPhone && callSid) {
      customerPhone = await this.inboundCalls.findCallerPhoneByCallSid(callSid);
      if (customerPhone) {
        logDelivery(this.logger, 'delivery.phone_resolved_from_call', {
          callSid,
          source: 'calls_table',
        });
      }
    }

    if (!customerPhone && !callSid && !phoneFromRequest) {
      logDeliveryWarn(this.logger, 'delivery.phone_missing', {
        orderId: input.orderId ?? null,
        emailDomain: customerEmail.split('@')[1] ?? null,
      });
    } else if (!customerPhone) {
      logDeliveryWarn(this.logger, 'delivery.phone_missing', {
        callSid,
        orderId: input.orderId ?? null,
        note: 'callSid present but no caller_phone row — ensure POST /api/elevenlabs/inbound ran for this CallSid',
      });
    }

    const country =
      (customerPhone ? detectPhoneCountry(customerPhone) : null) ??
      (callSid
        ? (
            await this.prisma.inboundCall.findUnique({
              where: { callSid },
              select: { callerCountry: true },
            })
          )?.callerCountry ?? null
        : null);

    logDelivery(this.logger, 'delivery.started', {
      callSid,
      orderId: input.orderId ?? null,
      emailDomain: customerEmail.split('@')[1] ?? null,
      hasPhone: Boolean(customerPhone),
      country,
      tenantId: input.tenantId ?? null,
      agentId: input.agentId ?? null,
    });

    let deliveryId = 'pending';
    try {
      const deliveryRow = await this.prisma.paymentDelivery.create({
        data: {
          callSid,
          orderId: input.orderId ?? null,
          customerEmail,
          customerPhone,
          country,
          paymentLink,
          emailStatus: 'pending',
          smsStatus: 'pending',
          whatsappStatus: 'pending',
        },
      });
      deliveryId = deliveryRow.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDeliveryError(this.logger, 'delivery.db_create_failed', {
        message: message.slice(0, 400),
        callSid,
        orderId: input.orderId ?? null,
      });
      deliveryId = `no-db-${Date.now()}`;
    }

    const result: PaymentLinkDeliveryResult = {
      email: 'failed',
      sms: 'skipped',
      whatsapp: 'skipped',
    };

    let emailMessageId: string | undefined;
    let emailError: string | undefined;
    let smsMessageSid: string | undefined;
    let smsError: string | undefined;
    let whatsappMessageSid: string | undefined;
    let whatsappError: string | undefined;

    // —— Email ——
    logDelivery(this.logger, 'delivery.email_attempted', {
      deliveryId,
      provider: this.emailDelivery.resolveProvider(),
    });

    const tmpl = buildPaymentEmailContent({
      businessName: input.businessName?.trim() || 'SureShot Books',
      supportEmail: input.supportEmail,
      supportPhone: input.supportPhone,
      checkoutUrl: paymentLink,
      items: input.lineItems ?? [{ title: 'Your order', quantity: 1, price: null }],
    });

    const emailCredentials = await this.resolveEmailCredentials(input.tenantId, input.agentId);
    const emailResult = await this.emailDelivery.sendPaymentLinkEmail({
      to: customerEmail,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
      replyTo: input.supportEmail,
      credentials: emailCredentials,
    });

    if (emailResult.ok) {
      result.email = 'sent';
      emailMessageId = emailResult.messageId;
      logDelivery(this.logger, 'delivery.email_sent', {
        deliveryId,
        messageId: emailMessageId ?? null,
        provider: emailResult.provider,
      });
    } else {
      result.email = 'failed';
      emailError = emailResult.error;
      logDeliveryError(this.logger, 'delivery.email_failed', {
        deliveryId,
        provider: emailResult.provider,
        error: emailError?.slice(0, 400) ?? null,
        providerResponse: emailResult.providerResponse ?? null,
      });
    }

    await this.persistDeliveryPatch(deliveryId, {
      emailStatus: result.email,
      emailMessageId: emailMessageId ?? null,
      emailError: emailError?.slice(0, 500) ?? null,
    });

    // —— SMS ——
    if (!customerPhone) {
      result.sms = 'skipped';
      smsError = 'No customer phone available.';
      logDelivery(this.logger, 'delivery.sms_skipped', { deliveryId, reason: 'no_phone' });
    } else if (!(await this.sms.hasTwilioCredentials(input.tenantId, input.agentId))) {
      result.sms = 'skipped';
      smsError = 'Twilio SMS credentials not configured.';
      logDeliveryWarn(this.logger, 'delivery.sms_skipped', { deliveryId, reason: 'twilio_not_configured' });
    } else {
      logDelivery(this.logger, 'delivery.sms_attempted', { deliveryId, country });
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
        if (smsResult.status === 'sent') {
          logDelivery(this.logger, 'delivery.sms_sent', { deliveryId, messageSid: smsMessageSid ?? null });
        } else if (smsResult.status === 'skipped') {
          logDelivery(this.logger, 'delivery.sms_skipped', { deliveryId, reason: smsError?.slice(0, 200) });
        } else {
          logDeliveryError(this.logger, 'delivery.sms_failed', {
            deliveryId,
            error: smsError?.slice(0, 400) ?? null,
          });
        }
      } catch (err) {
        result.sms = 'failed';
        smsError = err instanceof Error ? err.message : String(err);
        logDeliveryError(this.logger, 'delivery.sms_failed', {
          deliveryId,
          error: smsError.slice(0, 400),
        });
      }
    }

    await this.persistDeliveryPatch(deliveryId, {
      smsStatus: result.sms,
      smsMessageSid: smsMessageSid ?? null,
      smsError: smsError?.slice(0, 500) ?? null,
    });

    // —— WhatsApp ——
    if (!this.whatsapp.isEnabled()) {
      result.whatsapp = 'skipped';
      whatsappError = 'WhatsApp delivery is disabled.';
      logDelivery(this.logger, 'delivery.whatsapp_skipped', { deliveryId, reason: 'disabled' });
    } else if (!this.whatsapp.resolveWhatsAppFrom()) {
      result.whatsapp = 'skipped';
      whatsappError = 'TWILIO_WHATSAPP_FROM is not configured.';
      logDelivery(this.logger, 'delivery.whatsapp_skipped', { deliveryId, reason: 'no_sender' });
    } else if (!customerPhone) {
      result.whatsapp = 'skipped';
      whatsappError = 'No customer phone available.';
      logDelivery(this.logger, 'delivery.whatsapp_skipped', { deliveryId, reason: 'no_phone' });
    } else if (!(await this.whatsapp.hasTwilioCredentials(input.tenantId, input.agentId))) {
      result.whatsapp = 'skipped';
      whatsappError = 'Twilio credentials not configured.';
      logDeliveryWarn(this.logger, 'delivery.whatsapp_skipped', { deliveryId, reason: 'twilio_not_configured' });
    } else {
      logDelivery(this.logger, 'delivery.whatsapp_attempted', { deliveryId });
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
        if (waResult.status === 'sent') {
          logDelivery(this.logger, 'delivery.whatsapp_sent', {
            deliveryId,
            messageSid: whatsappMessageSid ?? null,
          });
        } else if (waResult.status === 'skipped') {
          logDelivery(this.logger, 'delivery.whatsapp_skipped', {
            deliveryId,
            reason: whatsappError?.slice(0, 200),
          });
        } else {
          logDeliveryError(this.logger, 'delivery.whatsapp_failed', {
            deliveryId,
            error: whatsappError?.slice(0, 400) ?? null,
          });
        }
      } catch (err) {
        result.whatsapp = 'failed';
        whatsappError = err instanceof Error ? err.message : String(err);
        logDeliveryError(this.logger, 'delivery.whatsapp_failed', {
          deliveryId,
          error: whatsappError.slice(0, 400),
        });
      }
    }

    await this.persistDeliveryPatch(deliveryId, {
      whatsappStatus: result.whatsapp,
      whatsappMessageSid: whatsappMessageSid ?? null,
      whatsappError: whatsappError?.slice(0, 500) ?? null,
    });

    const agentMessage = buildAgentDeliveryMessage(result);

    logDelivery(this.logger, 'delivery.completed', {
      deliveryId,
      callSid,
      orderId: input.orderId ?? null,
      email: result.email,
      sms: result.sms,
      whatsapp: result.whatsapp,
    });

    return {
      ...result,
      agentMessage,
      deliveryId,
      emailMessageId,
      emailError,
      smsMessageSid,
      smsError,
      whatsappMessageSid,
      whatsappError,
    };
  }

  private async resolveEmailCredentials(
    tenantId?: string,
    agentId?: string,
  ): Promise<import('./email-delivery.service').PaymentLinkEmailCredentials | null> {
    const paymentFromOverride = this.config.get<string>('PAYMENT_EMAIL_FROM')?.trim();

    if (tenantId && agentId) {
      const resolved = await this.agentEmailConfig.resolveForSend(tenantId, agentId);
      if (resolved) {
        const from = paymentFromOverride || resolved.from;
        return {
          apiKey: resolved.apiKey,
          from,
          replyTo: resolved.replyTo,
          provider: this.emailDelivery.resolveProvider(),
        };
      }
    }

    const from = paymentFromOverride || this.emailDelivery.resolveFromEmail();
    const provider = this.emailDelivery.resolveProvider();
    const apiKey =
      provider === 'sendgrid'
        ? this.config.get<string>('SENDGRID_API_KEY')?.trim() || process.env.SENDGRID_API_KEY?.trim()
        : this.config.get<string>('RESEND_API_KEY')?.trim() || process.env.RESEND_API_KEY?.trim();

    if (!from || !apiKey) return null;

    return {
      apiKey,
      from,
      provider: this.emailDelivery.resolveProvider(),
    };
  }

  private async persistDeliveryPatch(
    deliveryId: string,
    data: Record<string, string | null>,
  ): Promise<void> {
    if (deliveryId.startsWith('no-db-') || deliveryId === 'pending') return;
    try {
      await this.prisma.paymentDelivery.update({ where: { id: deliveryId }, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDeliveryWarn(this.logger, 'delivery.db_update_failed', {
        deliveryId,
        message: message.slice(0, 300),
      });
    }
  }
}
