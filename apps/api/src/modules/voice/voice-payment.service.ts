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
import { VoiceSearchService } from './voice-search.service';
import type { SendPaymentLinkInput } from './dto/send-payment-link-input.type';
import type { SendPaymentLinkResponseDto } from './dto/send-payment-link.dto';
import { maskEmailForLog } from '../calls/runtime/voice-email-capture.util';
import {
  isDuplicatePaymentRecipient,
  markRecipientPaymentSent,
  parsePaymentRecipients,
  PAYMENT_RECIPIENTS_METADATA_KEY,
  paymentRecipientPairKey,
  resolveProductIdForRecipient,
  sessionMetaPatchForRecipients,
} from '../calls/runtime/payment-recipient.util';
import {
  buildEmailSentLog,
  buildSendPaymentLinkFailureLog,
  evaluatePaymentEmailGate,
} from './utils/voice-payment-email-gate.util';
import {
  buildMissingProductQueryFailure,
  buildNoSearchMatchesFailure,
  buildSearchFailedFailure,
  isUsableShopifyVariantId,
  type ResolvePaymentVariantResult,
} from './utils/resolve-payment-variant.util';

@Injectable()
export class VoicePaymentService {
  private readonly logger = new Logger(VoicePaymentService.name);

  constructor(
    private readonly draftOrders: ShopifyDraftOrderService,
    private readonly paymentDelivery: PaymentLinkDeliveryService,
    private readonly callContext: VoiceCallContextService,
    private readonly catalog: VoicePaymentCatalogService,
    private readonly voiceSearch: VoiceSearchService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendPaymentLink(args: SendPaymentLinkInput): Promise<SendPaymentLinkResponseDto> {
    const started = Date.now();
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

      const emailConfirmedForGate = callSid?.trim()
        ? true
        : args.emailConfirmed === true;

      const gate = evaluatePaymentEmailGate({
        rawEmail,
        emailConfirmed: emailConfirmedForGate,
        sessionConfirmedEmail: sessionEmailState.confirmedEmail,
        sessionConfirmationState: sessionEmailState.confirmationState,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.email_gate',
          ...gate.debug,
          emailSource:
            args.email?.trim() ? 'tool' : sessionEmailState.confirmedEmail ? 'session' : 'none',
          emailConfirmedToolFlag: args.emailConfirmed === true,
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

      const { tenantId, agentId } = await this.resolveAgentContext(args.tenantId, args.agentId);

      const variantResolution = await this.resolveVariantIdForPayment({
        variantId: args.variantId,
        productName: args.productName,
        tenantId,
        agentId,
      });

      if (!variantResolution.ok) {
        this.logger.error(
          JSON.stringify({
            event: 'voice.payment.variant_resolve_failed',
            errorCode: variantResolution.errorCode,
            message: variantResolution.logMessage,
            productName: args.productName?.slice(0, 80) ?? null,
            variantIdProvided: Boolean(args.variantId?.trim()),
            callSid: callSid ?? null,
          }),
        );
        return {
          success: false,
          message: 'Could not resolve product for payment link.',
          agentMessage: variantResolution.agentMessage,
          error: variantResolution.logMessage,
          deliveryAttemptId: null,
          emailGate: gate.debug,
          latencyMs: Date.now() - started,
        };
      }

      const variantId = variantResolution.variantId;
      const productTitle = variantResolution.productTitle ?? args.productName?.trim() ?? 'Book';
      const productId = args.variantId?.trim() || variantId;

      const sessionRecipients = await this.loadCallSessionPaymentRecipients(callSid);
      if (isDuplicatePaymentRecipient(sessionRecipients, productId, email)) {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.payment.duplicate_recipient_blocked',
            productId: productId.slice(0, 80),
            maskedEmail: maskEmailForLog(email),
            idempotencyKey: paymentRecipientPairKey(productId, email),
            callSid: callSid ?? null,
          }),
        );
        return {
          success: true,
          message: 'Payment link was already sent for this book and email.',
          agentMessage:
            'I already sent a payment link for that book to that email address on this call.',
          deliveryAttemptId: null,
          emailGate: gate.debug,
          latencyMs: Date.now() - started,
        };
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.started',
          emailDomain: email.split('@')[1] ?? null,
          variantId: variantId.slice(0, 80),
          variantSource: variantResolution.source,
          productTitle: variantResolution.productTitle?.slice(0, 120) ?? null,
          quantity,
          smsRequested: Boolean(phoneNumber),
          callSid: callSid ?? null,
          callContextSource: callCtx.source,
          emailConfirmed: true,
        }),
      );

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

      if (emailDelivered && callSid) {
        await this.appendPaymentRecipientToCallSession(callSid, {
          productId,
          productTitle,
          variantId,
          recipientEmail: email,
          paymentLink: shopify.invoiceUrl,
          draftOrderId: shopify.draftOrderId,
          checkoutLinkId: checkoutLink.id,
          quantity,
        });
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
          recipientCount: sessionRecipients.length + (emailDelivered ? 1 : 0),
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
      const invalidCatalogProduct =
        /Product with ID 0/i.test(message) ||
        /INVALID_VARIANT_ID/i.test(message) ||
        /no longer available/i.test(message);

      this.logger.error(
        JSON.stringify({
          event: 'voice.payment.failed',
          message: message.slice(0, 400),
          latencyMs: Date.now() - started,
          variantIdRequested: args.variantId?.trim().slice(0, 80) ?? null,
          productName: args.productName?.trim().slice(0, 80) ?? null,
          ...buildSendPaymentLinkFailureLog({
            customerEmail: maskedEmail,
            errorMessage: message,
            deliveryAttemptId: null,
          }),
        }),
      );
      return {
        success: false,
        message: invalidCatalogProduct
          ? 'Could not resolve a valid product for checkout.'
          : 'Payment link could not be sent.',
        agentMessage: invalidCatalogProduct
          ? "I couldn't match that book in our catalog. What's the exact title you'd like to order?"
          : "I created your payment link, but I'm having trouble sending the email. Please confirm your email again.",
        error: message.slice(0, 300),
        deliveryAttemptId: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async resolveVariantIdForPayment(args: {
    variantId?: string;
    productName?: string;
    tenantId: string;
    agentId: string;
  }): Promise<ResolvePaymentVariantResult> {
    const providedVariantId = args.variantId?.trim();
    const invalidVariantIdForLog = args.variantId?.trim().slice(0, 80) ?? null;

    if (isUsableShopifyVariantId(providedVariantId)) {
      return { ok: true, variantId: providedVariantId, source: 'provided' };
    }

    const query = args.productName?.trim();
    if (!query) {
      if (invalidVariantIdForLog) {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.payment.invalid_variant_id',
            variantId: invalidVariantIdForLog,
            reason: 'not_usable_and_no_product_name',
          }),
        );
      }
      return buildMissingProductQueryFailure();
    }

    if (invalidVariantIdForLog) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.payment.invalid_variant_id',
          variantId: invalidVariantIdForLog,
          reason: 'falling_back_to_product_name_search',
          productName: query.slice(0, 80),
        }),
      );
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.variant_search_started',
        query: query.slice(0, 80),
        tenantId: args.tenantId,
        agentId: args.agentId,
      }),
    );

    const search = await this.voiceSearch.searchProduct({
      query,
      tenantId: args.tenantId,
      agentId: args.agentId,
      limit: 5,
    });

    if (!search.success) {
      return buildSearchFailedFailure(search.error ?? 'search failed');
    }

    if (!search.products.length) {
      return buildNoSearchMatchesFailure(query);
    }

    const top = search.products[0]!;
    if (!isUsableShopifyVariantId(top.variantId)) {
      return {
        ok: false,
        errorCode: 'invalid_search_result',
        agentMessage:
          "I found a listing but couldn't prepare checkout for it. Could you try another title?",
        logMessage: `top search result missing valid variantId for query="${query.slice(0, 80)}"`,
      };
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.variant_resolved_from_search',
        query: query.slice(0, 80),
        variantId: top.variantId.slice(0, 80),
        productTitle: top.title.slice(0, 120),
        cacheHit: search.cacheHit ?? false,
        matchCount: search.products.length,
      }),
    );

    return {
      ok: true,
      variantId: top.variantId,
      source: 'search',
      productTitle: top.title,
    };
  }

  private async loadCallSessionPaymentRecipients(callSid: string | null) {
    if (!callSid) return [];
    const session = await this.prisma.callSession.findFirst({
      where: { twilioCallSid: callSid },
      select: { metadata: true },
    });
    const meta =
      session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    return parsePaymentRecipients(meta[PAYMENT_RECIPIENTS_METADATA_KEY]);
  }

  private async appendPaymentRecipientToCallSession(
    callSid: string,
    args: {
      productId: string;
      productTitle: string;
      variantId: string;
      recipientEmail: string;
      paymentLink: string;
      draftOrderId: string;
      checkoutLinkId: string;
      quantity: number;
    },
  ): Promise<void> {
    const session = await this.prisma.callSession.findFirst({
      where: { twilioCallSid: callSid },
      select: { id: true, metadata: true },
    });
    if (!session) return;
    const meta =
      session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    const recipients = parsePaymentRecipients(meta[PAYMENT_RECIPIENTS_METADATA_KEY]);
    const productId = resolveProductIdForRecipient({
      title: args.productTitle,
      productId: args.productId,
      variantId: args.variantId,
    });
    const updated = markRecipientPaymentSent(recipients, productId, args.recipientEmail, {
      paymentLink: args.paymentLink,
      draftOrderId: args.draftOrderId,
      checkoutLinkId: args.checkoutLinkId,
      productTitle: args.productTitle,
      variantId: args.variantId,
      quantity: args.quantity,
    });
    await this.prisma.callSession.update({
      where: { id: session.id },
      data: {
        metadata: {
          ...meta,
          ...sessionMetaPatchForRecipients(updated),
          orderState: 'PAYMENT_LINK_SENT',
        } as Prisma.InputJsonValue,
      },
    });
    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.recipient_persisted',
        callSid,
        productId: productId.slice(0, 80),
        maskedEmail: maskEmailForLog(args.recipientEmail),
        recipientCount: updated.length,
      }),
    );
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
