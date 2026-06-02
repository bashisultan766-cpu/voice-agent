import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { ShopifyDraftOrderService } from '../integrations/shopify/draft-order';
import { ShopifyCheckoutValidationError } from '../integrations/shopify/shopify-errors';
import { PaymentLinkDeliveryService } from '../delivery/payment-link-delivery.service';
import { VoicePaymentCatalogService } from './voice-payment-catalog.service';
import { VoiceCallContextService } from './voice-call-context.service';
import type { SendPaymentLinkResponseDto } from './dto/send-payment-link.dto';
import { maskEmailForLog } from '../calls/runtime/voice-email-capture.util';
import {
  buildEmailSentLog,
  buildSendPaymentLinkFailureLog,
  evaluatePaymentEmailGate,
} from './utils/voice-payment-email-gate.util';

@Injectable()
export class VoicePaymentService {
  private readonly logger = new Logger(VoicePaymentService.name);

  constructor(
    private readonly draftOrders: ShopifyDraftOrderService,
    private readonly paymentDelivery: PaymentLinkDeliveryService,
    private readonly callContext: VoiceCallContextService,
    private readonly catalog: VoicePaymentCatalogService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendPaymentLink(args: {
    email: string;
    variantId: string;
    quantity: number;
    phoneNumber?: string;
    callSid?: string;
    tenantId?: string;
    agentId?: string;
    emailConfirmed?: boolean;
  }): Promise<SendPaymentLinkResponseDto> {
    const started = Date.now();
    const variantId = args.variantId.trim();
    const quantity = args.quantity;
    try {
      const callCtx = await this.callContext.resolveForPaymentLink({
        callSid: args.callSid,
        phoneNumber: args.phoneNumber,
      });
      const phoneNumber = callCtx.phoneNumber;
      const callSid = callCtx.callSid;

      const sessionEmailState = await this.resolveCallSessionEmailState(callSid);
      const rawEmail =
        args.email?.trim() ||
        (sessionEmailState.confirmationState === 'confirmed'
          ? sessionEmailState.confirmedEmail?.trim() ?? ''
          : '');

      const gate = evaluatePaymentEmailGate({
        rawEmail,
        emailConfirmed: args.emailConfirmed,
        sessionConfirmedEmail: sessionEmailState.confirmedEmail,
        sessionConfirmationState: sessionEmailState.confirmationState,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.email_gate',
          ...gate.debug,
          emailSource:
            args.email?.trim() ? 'tool' : sessionEmailState.confirmedEmail ? 'session' : 'none',
          maskedEmail: gate.normalizedEmail ? maskEmailForLog(gate.normalizedEmail) : null,
          possiblyInvalid: gate.possiblyInvalid,
          callSid: callSid ?? null,
        }),
      );

      if (!gate.allowed) {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.payment.email_gate_blocked',
            ...gate.debug,
            maskedEmail: gate.normalizedEmail ? maskEmailForLog(gate.normalizedEmail) : null,
          }),
        );
        return {
          success: false,
          message: 'Email must be validated and confirmed before sending a payment link.',
          agentMessage: gate.agentMessage,
          emailGate: gate.debug,
          deliveryAttemptId: null,
          latencyMs: Date.now() - started,
        };
      }

      const email = gate.normalizedEmail;

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.started',
          emailDomain: email.split('@')[1] ?? null,
          variantId: variantId.slice(0, 80),
          quantity,
          smsRequested: Boolean(phoneNumber),
          callSid: callSid ?? null,
          callContextSource: callCtx.source,
          emailConfirmed: true,
        }),
      );

      const { tenantId, agentId } = await this.resolveAgentContext(args.tenantId, args.agentId);
      const lineItem = await this.catalog.resolveLineItem(tenantId, agentId, variantId, quantity);

      const shopify = await this.draftOrders.sendDraftOrderPaymentLink(tenantId, agentId, {
        email,
        variantId,
        quantity,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.draft_order_created',
          tenantId,
          agentId,
          draftOrderId: shopify.draftOrderId,
          invoiceUrlPresent: Boolean(shopify.invoiceUrl),
        }),
      );

      if (shopify.shopifyInvoiceSent) {
        this.logger.log(
          JSON.stringify({
            event: 'voice.payment.shopify_invoice_sent',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            emailDomain: email.split('@')[1] ?? null,
          }),
        );
      } else {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.payment.shopify_invoice_skipped',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            shopifyInvoiceError: shopify.shopifyInvoiceError?.slice(0, 300) ?? null,
          }),
        );
      }

      const checkoutLink = await this.persistCheckoutLink({
        tenantId,
        agentId,
        email,
        invoiceUrl: shopify.invoiceUrl,
        draftOrderId: shopify.draftOrderId,
        shopifyConnectionId: shopify.shopifyConnectionId,
        lineItem,
        callSid: callSid ?? undefined,
      });

      const branding = await this.resolveBusinessBranding(tenantId, agentId);

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.delivery_invoked',
          tenantId,
          agentId,
          draftOrderId: shopify.draftOrderId,
          callSid: callSid ?? null,
          hasPhoneNumber: Boolean(phoneNumber),
        }),
      );

      const delivery = await this.paymentDelivery.deliverPaymentLink({
        customerEmail: email,
        customerPhone: phoneNumber,
        paymentLink: shopify.invoiceUrl,
        callSid,
        orderId: shopify.draftOrderId,
        tenantId,
        agentId,
        callerCountry: callCtx.country,
        businessName: branding.businessName,
        supportEmail: branding.supportEmail,
        supportPhone: branding.supportPhone,
        lineItems: [
          {
            title: lineItem.title,
            quantity: lineItem.quantity,
            price: lineItem.price,
          },
        ],
      });

      const emailSentByResend = delivery.email === 'sent';
      const smsSent = delivery.sms === 'sent';
      const whatsappSent = delivery.whatsapp === 'sent';
      const emailSentByShopify = shopify.shopifyInvoiceSent;

      if (emailSentByResend) {
        await this.prisma.checkoutLink.update({
          where: { id: checkoutLink.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.delivery_result',
          tenantId,
          agentId,
          draftOrderId: shopify.draftOrderId,
          deliveryId: delivery.deliveryId,
          email: delivery.email,
          sms: delivery.sms,
          whatsapp: delivery.whatsapp,
          emailSentByShopify,
          emailSentByResend,
          emailError: delivery.emailError?.slice(0, 200) ?? null,
          smsError: delivery.smsError?.slice(0, 200) ?? null,
          whatsappError: delivery.whatsappError?.slice(0, 200) ?? null,
        }),
      );

      const emailDelivered = emailSentByShopify || emailSentByResend;
      const latencyMs = Date.now() - started;

      if (!emailDelivered && !smsSent && !whatsappSent) {
        const errorMessage =
          delivery.emailError?.trim() ||
          delivery.smsError?.trim() ||
          delivery.whatsappError?.trim() ||
          'Payment link could not be delivered.';
        this.logger.error(
          JSON.stringify({
            event: 'voice.payment.failed',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            deliveryId: delivery.deliveryId,
            emailSentByShopify,
            emailSentByResend,
            smsSent,
            whatsappSent,
            latencyMs,
            ...buildSendPaymentLinkFailureLog({
              customerEmail: maskEmailForLog(email),
              errorMessage,
              deliveryAttemptId: delivery.deliveryId,
            }),
          }),
        );
        return {
          success: false,
          message: 'Payment link could not be delivered.',
          agentMessage: delivery.agentMessage,
          draftOrderId: shopify.draftOrderId,
          delivery: {
            email: delivery.email,
            sms: delivery.sms,
            whatsapp: delivery.whatsapp,
          },
          error: errorMessage,
          deliveryAttemptId: delivery.deliveryId,
          emailGate: gate.debug,
          latencyMs,
        };
      }

      if (emailDelivered) {
        this.logger.log(
          JSON.stringify(
            buildEmailSentLog({
              customerEmail: maskEmailForLog(email),
              emailConfirmed: true,
              deliveryAttemptId: delivery.deliveryId,
              draftOrderId: shopify.draftOrderId,
            }),
          ),
        );
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.completed',
          tenantId,
          agentId,
          draftOrderId: shopify.draftOrderId,
          deliveryId: delivery.deliveryId,
          emailSentByShopify,
          emailSentByResend,
          smsSent,
          whatsappSent,
          latencyMs,
        }),
      );

      return {
        success: true,
        message: 'Payment link sent successfully.',
        agentMessage: delivery.agentMessage,
        draftOrderId: shopify.draftOrderId,
        delivery: {
          email: delivery.email,
          sms: delivery.sms,
          whatsapp: delivery.whatsapp,
        },
        deliveryAttemptId: delivery.deliveryId,
        emailGate: gate.debug,
        latencyMs,
      };
    } catch (err) {
      const message = this.formatError(err);
      const maskedEmail = args.email?.trim() ? maskEmailForLog(args.email.trim().toLowerCase()) : '';
      this.logger.error(
        JSON.stringify({
          event: 'voice.payment.failed',
          message: message.slice(0, 400),
          latencyMs: Date.now() - started,
          ...buildSendPaymentLinkFailureLog({
            customerEmail: maskedEmail,
            errorMessage: message,
            deliveryAttemptId: null,
          }),
        }),
      );
      return {
        success: false,
        message: 'Payment link could not be sent.',
        agentMessage:
          "I created your payment link, but I'm having trouble sending the email. Please confirm your email again.",
        error: message.slice(0, 300),
        deliveryAttemptId: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async resolveCallSessionEmailState(callSid: string | null): Promise<{
    confirmedEmail: string | null;
    confirmationState: 'pending' | 'confirmed' | 'rejected' | null;
  }> {
    if (!callSid) {
      return { confirmedEmail: null, confirmationState: null };
    }

    const session = await this.prisma.callSession.findFirst({
      where: { twilioCallSid: callSid },
      select: { metadata: true },
    });
    const meta =
      session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};

    const state = meta.emailConfirmationState;
    const confirmationState =
      state === 'confirmed' || state === 'pending' || state === 'rejected' ? state : null;

    const confirmedEmail =
      (typeof meta.normalizedEmail === 'string' && meta.normalizedEmail.trim()) ||
      null;

    return { confirmedEmail, confirmationState };
  }

  private async persistCheckoutLink(args: {
    tenantId: string;
    agentId: string;
    email: string;
    invoiceUrl: string;
    draftOrderId: string;
    shopifyConnectionId: string | null;
    lineItem: { title: string; quantity: number; price: string | null; variantId: string };
    callSid?: string;
  }) {
    const fingerprint = createHash('sha256')
      .update(
        [
          args.tenantId,
          args.agentId,
          args.draftOrderId,
          args.email,
          args.lineItem.variantId,
          String(args.lineItem.quantity),
        ].join('|'),
        'utf8',
      )
      .digest('hex');

    let callSessionId: string | undefined;
    if (args.callSid) {
      const session = await this.prisma.callSession.findFirst({
        where: { twilioCallSid: args.callSid },
        select: { id: true },
      });
      callSessionId = session?.id;
    }

    return this.prisma.checkoutLink.create({
      data: {
        tenantId: args.tenantId,
        agentId: args.agentId,
        callSessionId,
        checkoutFingerprint: fingerprint,
        shopifyConnectionId: args.shopifyConnectionId,
        mode: 'DRAFT_ORDER_INVOICE',
        checkoutUrl: args.invoiceUrl,
        customerEmail: args.email,
        itemsJson: [
          {
            title: args.lineItem.title,
            quantity: args.lineItem.quantity,
            price: args.lineItem.price,
            variantId: args.lineItem.variantId,
          },
        ] as unknown as Prisma.InputJsonValue,
        providerRef: args.draftOrderId,
        status: 'CREATED',
        metadata: {
          source: 'voice_send_payment_link',
          draftOrderId: args.draftOrderId,
          callSid: args.callSid ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  private async resolveBusinessBranding(
    tenantId: string,
    agentId: string,
  ): Promise<{
    businessName: string;
    supportEmail: string | null;
    supportPhone: string | null;
  }> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        agentConfig: {
          select: { businessName: true, supportEmail: true, supportPhone: true },
        },
        client: { select: { name: true, contactEmail: true, contactPhone: true } },
      },
    });

    return {
      businessName:
        agent?.agentConfig?.businessName?.trim() ||
        agent?.client?.name?.trim() ||
        'SureShot Books',
      supportEmail: agent?.agentConfig?.supportEmail ?? agent?.client?.contactEmail ?? null,
      supportPhone: agent?.agentConfig?.supportPhone ?? agent?.client?.contactPhone ?? null,
    };
  }

  private formatError(err: unknown): string {
    if (err instanceof ShopifyCheckoutValidationError) return err.message;
    if (err instanceof BadRequestException) {
      const res = err.getResponse();
      if (typeof res === 'string') return res;
      if (typeof res === 'object' && res !== null && 'message' in res) {
        const msg = (res as { message?: string | string[] }).message;
        return Array.isArray(msg) ? msg.join('; ') : String(msg ?? err.message);
      }
    }
    return err instanceof Error ? err.message : String(err);
  }

  private async resolveAgentContext(
    tenantId?: string,
    agentId?: string,
  ): Promise<{ tenantId: string; agentId: string }> {
    const envTenant = this.config.get<string>('VOICE_DEFAULT_TENANT_ID')?.trim();
    const envAgent = this.config.get<string>('VOICE_DEFAULT_AGENT_ID')?.trim();

    const resolvedTenant = tenantId?.trim() || envTenant;
    const resolvedAgent = agentId?.trim() || envAgent;

    if (resolvedTenant && resolvedAgent) {
      return { tenantId: resolvedTenant, agentId: resolvedAgent };
    }

    const agent = await this.prisma.agent.findFirst({
      where: { deletedAt: null, status: { in: [AgentStatus.ACTIVE, AgentStatus.READY] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, tenantId: true },
    });
    if (!agent) {
      throw new BadRequestException(
        'No agent context. Provide tenantId/agentId or set VOICE_DEFAULT_TENANT_ID and VOICE_DEFAULT_AGENT_ID.',
      );
    }
    return { tenantId: resolvedTenant ?? agent.tenantId, agentId: resolvedAgent ?? agent.id };
  }
}
