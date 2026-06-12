import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus, CallStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { ShopifyDraftOrderService } from '../integrations/shopify/draft-order';
import type { DraftOrderPaymentLinkResult } from '../integrations/shopify/draft-order';
import {
  buildShopifyEmailRejectionLog,
  isShopifyInvalidEmailDomainError,
} from '../integrations/shopify/shopify-email-domain.util';
import { ShopifyCheckoutValidationError } from '../integrations/shopify/shopify-errors';
import {
  extractEmailDomain,
  suggestEmailTypo,
} from '../calls/runtime/voice-email-enterprise-validation.util';
import { PaymentLinkDeliveryService } from '../delivery/payment-link-delivery.service';
import { VoicePaymentCatalogService } from './voice-payment-catalog.service';
import { VoiceCallContextService } from './voice-call-context.service';
import { VoiceSearchService } from './voice-search.service';
import type { SendPaymentLinkInput } from './dto/send-payment-link-input.type';
import type { SendPaymentLinkResponseDto } from './dto/send-payment-link.dto';
import { maskEmailForLog } from '../calls/runtime/voice-email-capture.util';
import {
  batchAfterSuccessfulInvoice,
  buildCheckoutExecutionPlan,
  buildFinalizeBatchCheckoutPlan,
  EMAIL_CHECKOUT_BATCHES_KEY,
  parseEmailCheckoutBatches,
  recipientsAfterAggregatedSend,
  registerLineToEmailBatch,
  sessionMetaPatchForEmailBatches,
  type AggregatedCheckoutLine,
  type EmailCheckoutBatch,
} from '../calls/runtime/order-aggregation-by-email.util';
import {
  isDuplicatePaymentRecipient,
  normalizeRecipientEmail,
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
import {
  checkoutStateLookbackSince,
  extractCallSidFromCheckoutMetadata,
  hydrateCheckoutStateFromCheckoutLinks,
  mergeCheckoutSessionState,
} from './utils/voice-call-checkout-state.util';
import { buildAggregatedPaymentAgentMessage } from './utils/build-aggregated-payment-agent-message.util';
import {
  isFinalizeOnlyRequest,
  MAX_VOICE_CHECKOUT_LINES,
  resolveVoiceFinalizeCheckout,
} from './utils/resolve-voice-finalize-checkout.util';

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

  /**
   * Multiple books in ONE tool call (e.g. caller lists several ISBNs in one sentence).
   * Queues every product on the same email batch, then finalizes once →
   * ONE Shopify draft order + ONE invoice email listing ALL books.
   */
  async sendPaymentLinkForProducts(args: {
    items: Array<{ productName?: string; variantId?: string; quantity: number }>;
    email: string;
    phoneNumber?: string;
    callSid?: string;
    tenantId?: string;
    agentId?: string;
    emailConfirmed?: boolean;
    finalizeCheckout?: boolean;
  }): Promise<SendPaymentLinkResponseDto> {
    const { items, ...shared } = args;

    if (items.length <= 1) {
      const only = items[0];
      return this.sendPaymentLink({
        ...shared,
        productName: only?.productName,
        variantId: only?.variantId,
        quantity: only?.quantity ?? 1,
      });
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.multi_product_started',
        itemCount: items.length,
        callSid: shared.callSid ?? null,
      }),
    );

    // Resolve every product up-front, then create ONE draft order in a single
    // sendPaymentLink call. This must NOT rely on call-session persistence
    // (callSid can be missing from the tool payload).
    const { tenantId, agentId } = await this.resolveAgentContext(
      shared.tenantId,
      shared.agentId,
    );

    const resolvedLines: AggregatedCheckoutLine[] = [];
    const failedTitles: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const resolution = await this.resolveVariantIdForPayment({
        variantId: item.variantId,
        productName: item.productName,
        tenantId,
        agentId,
      });

      if (!resolution.ok) {
        failedTitles.push(item.productName || item.variantId || `book ${i + 1}`);
        this.logger.warn(
          JSON.stringify({
            event: 'voice.payment.multi_product_item_failed',
            index: i,
            productName: item.productName?.slice(0, 80) ?? null,
            errorCode: resolution.errorCode,
            message: resolution.logMessage?.slice(0, 200),
            callSid: shared.callSid ?? null,
          }),
        );
        continue;
      }

      resolvedLines.push({
        productId: item.variantId?.trim() || resolution.variantId,
        variantId: resolution.variantId,
        productTitle: resolution.productTitle ?? item.productName?.trim() ?? 'Book',
        quantity: Math.max(1, item.quantity),
      });
    }

    if (resolvedLines.length === 0) {
      return {
        success: false,
        message: 'None of the requested products could be added to the payment link.',
        agentMessage:
          'I could not find any of those books in the catalog. Could you repeat the titles or ISBN numbers one at a time?',
        deliveryAttemptId: null,
      };
    }

    const current = resolvedLines[resolvedLines.length - 1];
    const extraLines = resolvedLines.slice(0, -1);

    const response = await this.sendPaymentLink({
      ...shared,
      tenantId,
      agentId,
      variantId: current.variantId,
      productName: current.productTitle,
      quantity: current.quantity,
      finalizeCheckout: shared.finalizeCheckout !== false,
      extraLines,
    });

    if (response.success && failedTitles.length > 0) {
      const failNote = ` Note: I could not find ${failedTitles.join(', ')} in the catalog, so ${
        failedTitles.length === 1 ? 'that book is' : 'those books are'
      } not on the invoice.`;
      return {
        ...response,
        agentMessage: `${response.agentMessage ?? ''}${failNote}`.trim(),
        warning: `Unresolved products: ${failedTitles.join(', ')}`,
      };
    }

    return response;
  }

  async sendPaymentLink(args: SendPaymentLinkInput): Promise<SendPaymentLinkResponseDto> {
    const started = Date.now();
    const quantity = args.quantity ?? 1;
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
            ...(gate.rejectionLog ?? {}),
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

      const sessionState = await this.loadCallSessionCheckoutState({
        callSid,
        tenantId,
        agentId,
        email,
      });

      // Multi-product call: pre-resolved books are merged into the email batch
      // in-memory so ONE invoice carries all of them, with or without a session.
      if (args.extraLines?.length) {
        const batchKey = normalizeRecipientEmail(email);
        let batch: EmailCheckoutBatch = sessionState.batches[batchKey] ?? {
          recipientEmail: batchKey,
          draftOrderId: null,
          shopifyInvoiceSent: false,
          lines: [],
          status: 'accumulating',
        };
        for (const line of args.extraLines) {
          batch = registerLineToEmailBatch(batch, line);
        }
        sessionState.batches[batchKey] = batch;
      }

      const finalizeCheckout = resolveVoiceFinalizeCheckout({
        explicit: args.finalizeCheckout,
        email,
        batches: sessionState.batches,
      });
      const finalizeOnly = isFinalizeOnlyRequest({
        finalizeCheckout: args.finalizeCheckout,
        variantId: args.variantId,
        productName: args.productName,
      });

      if (finalizeOnly) {
        return this.finalizeQueuedCheckoutBatch({
          started,
          email,
          callSid,
          phoneNumber,
          callCtx,
          gate,
          tenantId,
          agentId,
          sessionState,
        });
      }

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

      const sessionRecipients = sessionState.recipients;

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

      const checkoutPlan = buildCheckoutExecutionPlan({
        recipients: sessionRecipients,
        batches: sessionState.batches,
        email,
        callSid,
        current: { productId, variantId, productTitle, quantity },
        finalizeCheckout,
      });

      if (checkoutPlan.lines.length > MAX_VOICE_CHECKOUT_LINES) {
        return {
          success: false,
          message: `Checkout is limited to ${MAX_VOICE_CHECKOUT_LINES} books per email.`,
          agentMessage: `I can include up to ${MAX_VOICE_CHECKOUT_LINES} books on one payment link. Would you like to split these across two orders?`,
          deliveryAttemptId: null,
          emailGate: gate.debug,
          latencyMs: Date.now() - started,
        };
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.aggregation_plan',
          aggregationMode: checkoutPlan.aggregationMode,
          aggregatedLineCount: checkoutPlan.lines.length,
          draftOrderId: checkoutPlan.existingDraftOrderId,
          shopifyInvoiceSent: checkoutPlan.shopifyInvoiceAlreadySent,
          resendEmailSkippedBecauseShopifySent: checkoutPlan.resendEmailSkippedBecauseShopifySent,
          duplicateInvoicePrevented: checkoutPlan.duplicateInvoicePrevented,
          finalizeCheckout,
          idempotencyKey: checkoutPlan.idempotencyKey,
          maskedEmail: maskEmailForLog(email),
          callSid: callSid ?? null,
        }),
      );

      if (checkoutPlan.duplicateInvoicePrevented) {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.payment.duplicate_invoice_prevented',
            aggregationMode: checkoutPlan.aggregationMode,
            draftOrderId: checkoutPlan.existingDraftOrderId,
            shopifyInvoiceSent: checkoutPlan.shopifyInvoiceAlreadySent,
            duplicateInvoicePrevented: true,
            idempotencyKey: checkoutPlan.idempotencyKey,
            callSid: callSid ?? null,
            maskedEmail: maskEmailForLog(email),
          }),
        );
        return {
          success: true,
          message: 'Payment invoice was already sent for this checkout.',
          agentMessage:
            'Your payment invoice was already sent to that email. Please check your inbox for the existing invoice.',
          draftOrderId: checkoutPlan.existingDraftOrderId ?? undefined,
          deliveryAttemptId: null,
          emailGate: gate.debug,
          latencyMs: Date.now() - started,
        };
      }

      if (!finalizeCheckout) {
        let persistedLineCount = checkoutPlan.lines.length;
        if (callSid) {
          persistedLineCount = await this.persistCheckoutBatchToCallSession(callSid, {
            tenantId,
            agentId,
            email,
            batch: checkoutPlan.batch,
            workingRecipients: checkoutPlan.workingRecipients,
          });
        }
        this.logger.log(
          JSON.stringify({
            event: 'voice.payment.product_queued',
            aggregationMode: 'queue',
            aggregatedLineCount: persistedLineCount,
            finalizeCheckout: false,
            callSid: callSid ?? null,
            maskedEmail: maskEmailForLog(email),
          }),
        );
        return {
          success: true,
          message: 'Product queued for checkout.',
          agentMessage:
            "I've added that book to your order. Tell me if you'd like another book, or let me know when you're ready for your payment link.",
          deliveryAttemptId: null,
          emailGate: gate.debug,
          latencyMs: Date.now() - started,
        };
      }

      const resolvedLineItems = await Promise.all(
        checkoutPlan.lines.map(async (line) => {
          const catalogLine = await this.catalog.resolveLineItem(
            tenantId,
            agentId,
            line.variantId,
            line.quantity,
          );
          return {
            variantId: line.variantId,
            quantity: line.quantity,
            productId: line.productId,
            productTitle: line.productTitle,
            title: catalogLine.title,
            price: catalogLine.price,
          };
        }),
      );

      const shopify = await this.sendAggregatedDraftOrderWithEmailRetry(tenantId, agentId, email, {
        lines: resolvedLineItems.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
        })),
        existingDraftOrderId: checkoutPlan.existingDraftOrderId,
        sendShopifyInvoice: checkoutPlan.sendShopifyInvoice,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.draft_order_created',
          tenantId,
          agentId,
          draftOrderId: shopify.draftOrderId,
          invoiceUrlPresent: Boolean(shopify.invoiceUrl),
          aggregationMode: checkoutPlan.aggregationMode,
          aggregatedLineCount: resolvedLineItems.length,
          shopifyInvoiceSent: shopify.shopifyInvoiceSent,
          resendEmailSkippedBecauseShopifySent:
            checkoutPlan.resendEmailSkippedBecauseShopifySent || shopify.shopifyInvoiceSent,
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
        lineItems: resolvedLineItems.map((line) => ({
          title: line.title,
          quantity: line.quantity,
          price: line.price,
          variantId: line.variantId,
        })),
        callSid: callSid ?? undefined,
        aggregationMode: checkoutPlan.aggregationMode,
        shopifyInvoiceSent: shopify.shopifyInvoiceSent,
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

      const skipResendEmail =
        checkoutPlan.skipResendEmail || shopify.shopifyInvoiceSent;
      if (skipResendEmail) {
        this.logger.log(
          JSON.stringify({
            event: 'voice.payment.resend_email_skipped',
            resendEmailSkippedBecauseShopifySent: shopify.shopifyInvoiceSent,
            aggregationMode: checkoutPlan.aggregationMode,
            draftOrderId: shopify.draftOrderId,
            callSid: callSid ?? null,
          }),
        );
      }
      const delivery = skipResendEmail
        ? {
            email: 'skipped' as const,
            sms: 'skipped' as const,
            whatsapp: 'skipped' as const,
            deliveryId: null,
            agentMessage:
              "I've added that book to your existing payment link. Use the same checkout link in your email.",
            emailError: null,
            smsError: null,
            whatsappError: null,
          }
        : await this.paymentDelivery.deliverPaymentLink({
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
            lineItems: resolvedLineItems.map((line) => ({
              title: line.title,
              quantity: line.quantity,
              price: line.price,
            })),
          });

      const emailSentByResend = delivery.email === 'sent';
      const smsSent = delivery.sms === 'sent';
      const whatsappSent = delivery.whatsapp === 'sent';
      const emailSentByShopify = shopify.shopifyInvoiceSent;
      const draftOrderUpdatedInPlace =
        checkoutPlan.aggregationMode === 'update' && checkoutPlan.shopifyInvoiceAlreadySent;

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

      const emailDelivered =
        draftOrderUpdatedInPlace || emailSentByShopify || emailSentByResend;
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
        const invoicedBatch = batchAfterSuccessfulInvoice(checkoutPlan.batch, {
          draftOrderId: shopify.draftOrderId,
          shopifyInvoiceSent: shopify.shopifyInvoiceSent,
        });
        await this.appendAggregatedPaymentRecipientsToCallSession(callSid, {
          tenantId,
          agentId,
          recipientEmail: email,
          paymentLink: shopify.invoiceUrl,
          draftOrderId: shopify.draftOrderId,
          checkoutLinkId: checkoutLink.id,
          productIds: resolvedLineItems.map((line) => line.productId),
          workingRecipients: checkoutPlan.workingRecipients,
          batches: {
            ...sessionState.batches,
            [normalizeRecipientEmail(email)]: invoicedBatch,
          },
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
          recipientCount:
            sessionRecipients.length +
            (emailDelivered ? resolvedLineItems.length : 0),
          aggregatedLineCount: resolvedLineItems.length,
        }),
      );

      const aggregatedAgentMessage =
        delivery.agentMessage?.trim() &&
        !delivery.agentMessage.includes('existing payment link')
          ? delivery.agentMessage
          : buildAggregatedPaymentAgentMessage(resolvedLineItems.length);

      return {
        success: true,
        message: 'Payment link sent successfully.',
        agentMessage: aggregatedAgentMessage,
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
      const normalizedEmail = args.email?.trim().toLowerCase() ?? '';
      const maskedEmail = normalizedEmail ? maskEmailForLog(normalizedEmail) : '';
      const invalidCatalogProduct =
        /Product with ID 0/i.test(message) ||
        /INVALID_VARIANT_ID/i.test(message) ||
        /no longer available/i.test(message);
      const shopifyEmailDomainRejected = isShopifyInvalidEmailDomainError(message);

      this.logger.error(
        JSON.stringify({
          event: 'voice.payment.failed',
          message: message.slice(0, 400),
          latencyMs: Date.now() - started,
          variantIdRequested: args.variantId?.trim().slice(0, 80) ?? null,
          productName: args.productName?.trim().slice(0, 80) ?? null,
          ...(shopifyEmailDomainRejected
            ? buildShopifyEmailRejectionLog({
                originalEmail: args.email?.trim() ?? normalizedEmail,
                normalizedEmail,
                domain: extractEmailDomain(normalizedEmail),
                validationResult: message,
              })
            : {}),
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
          : shopifyEmailDomainRejected
            ? 'That email domain could not be verified for checkout. Please spell your email address slowly, including the part after the at sign.'
            : "I created your payment link, but I'm having trouble sending the email. Please confirm your email again.",
        error: message.slice(0, 300),
        deliveryAttemptId: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async finalizeQueuedCheckoutBatch(args: {
    started: number;
    email: string;
    callSid: string | null | undefined;
    phoneNumber: string | null | undefined;
    callCtx: Awaited<ReturnType<VoiceCallContextService['resolveForPaymentLink']>>;
    gate: ReturnType<typeof evaluatePaymentEmailGate>;
    tenantId: string;
    agentId: string;
    sessionState: Awaited<ReturnType<VoicePaymentService['loadCallSessionCheckoutState']>>;
  }): Promise<SendPaymentLinkResponseDto> {
    const checkoutPlan = buildFinalizeBatchCheckoutPlan({
      recipients: args.sessionState.recipients,
      batches: args.sessionState.batches,
      email: args.email,
      callSid: args.callSid,
    });

    if (!checkoutPlan) {
      return {
        success: false,
        message: 'No books are queued for this email on this call.',
        agentMessage:
          "I don't have any books saved for that email yet. Tell me which titles you'd like, and I'll add them before sending your payment link.",
        deliveryAttemptId: null,
        emailGate: args.gate.debug,
        latencyMs: Date.now() - args.started,
      };
    }

    if (checkoutPlan.lines.length > MAX_VOICE_CHECKOUT_LINES) {
      return {
        success: false,
        message: `Checkout is limited to ${MAX_VOICE_CHECKOUT_LINES} books per email.`,
        agentMessage: `I can include up to ${MAX_VOICE_CHECKOUT_LINES} books on one payment link. Would you like to split these across two orders?`,
        deliveryAttemptId: null,
        emailGate: args.gate.debug,
        latencyMs: Date.now() - args.started,
      };
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.finalize_batch_only',
        aggregatedLineCount: checkoutPlan.lines.length,
        aggregationMode: checkoutPlan.aggregationMode,
        callSid: args.callSid ?? null,
        maskedEmail: maskEmailForLog(args.email),
      }),
    );

    if (checkoutPlan.duplicateInvoicePrevented) {
      return {
        success: true,
        message: 'Payment invoice was already sent for this checkout.',
        agentMessage:
          'Your payment invoice was already sent to that email. Please check your inbox for the existing invoice.',
        draftOrderId: checkoutPlan.existingDraftOrderId ?? undefined,
        deliveryAttemptId: null,
        emailGate: args.gate.debug,
        latencyMs: Date.now() - args.started,
      };
    }

    const resolvedLineItems = await Promise.all(
      checkoutPlan.lines.map(async (line) => {
        const catalogLine = await this.catalog.resolveLineItem(
          args.tenantId,
          args.agentId,
          line.variantId,
          line.quantity,
        );
        return {
          variantId: line.variantId,
          quantity: line.quantity,
          productId: line.productId,
          productTitle: line.productTitle,
          title: catalogLine.title,
          price: catalogLine.price,
        };
      }),
    );

    const shopify = await this.sendAggregatedDraftOrderWithEmailRetry(
      args.tenantId,
      args.agentId,
      args.email,
      {
        lines: resolvedLineItems.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
        })),
        existingDraftOrderId: checkoutPlan.existingDraftOrderId,
        sendShopifyInvoice: checkoutPlan.sendShopifyInvoice,
      },
    );

    const checkoutLink = await this.persistCheckoutLink({
      tenantId: args.tenantId,
      agentId: args.agentId,
      email: args.email,
      invoiceUrl: shopify.invoiceUrl,
      draftOrderId: shopify.draftOrderId,
      shopifyConnectionId: shopify.shopifyConnectionId,
      lineItems: resolvedLineItems.map((line) => ({
        title: line.title,
        quantity: line.quantity,
        price: line.price,
        variantId: line.variantId,
      })),
      callSid: args.callSid ?? undefined,
      aggregationMode: checkoutPlan.aggregationMode,
      shopifyInvoiceSent: shopify.shopifyInvoiceSent,
    });

    const branding = await this.resolveBusinessBranding(args.tenantId, args.agentId);
    const skipResendEmail = checkoutPlan.skipResendEmail || shopify.shopifyInvoiceSent;
    const delivery = skipResendEmail
      ? {
          email: 'skipped' as const,
          sms: 'skipped' as const,
          whatsapp: 'skipped' as const,
          deliveryId: null,
          agentMessage: buildAggregatedPaymentAgentMessage(resolvedLineItems.length),
          emailError: null,
          smsError: null,
          whatsappError: null,
        }
      : await this.paymentDelivery.deliverPaymentLink({
          customerEmail: args.email,
          customerPhone: args.phoneNumber ?? undefined,
          paymentLink: shopify.invoiceUrl,
          callSid: args.callSid ?? undefined,
          orderId: shopify.draftOrderId,
          tenantId: args.tenantId,
          agentId: args.agentId,
          callerCountry: args.callCtx.country,
          businessName: branding.businessName,
          supportEmail: branding.supportEmail,
          supportPhone: branding.supportPhone,
          lineItems: resolvedLineItems.map((line) => ({
            title: line.title,
            quantity: line.quantity,
            price: line.price,
          })),
        });

    const emailSentByResend = delivery.email === 'sent';
    const emailSentByShopify = shopify.shopifyInvoiceSent;
    const emailDelivered = emailSentByShopify || emailSentByResend;
    const latencyMs = Date.now() - args.started;

    if (!emailDelivered && delivery.sms !== 'sent' && delivery.whatsapp !== 'sent') {
      const errorMessage =
        delivery.emailError?.trim() ||
        delivery.smsError?.trim() ||
        delivery.whatsappError?.trim() ||
        'Payment link could not be delivered.';
      return {
        success: false,
        message: 'Payment link could not be delivered.',
        agentMessage: delivery.agentMessage,
        draftOrderId: shopify.draftOrderId,
        error: errorMessage,
        deliveryAttemptId: delivery.deliveryId,
        emailGate: args.gate.debug,
        latencyMs,
      };
    }

    if (emailDelivered && args.callSid) {
      const invoicedBatch = batchAfterSuccessfulInvoice(checkoutPlan.batch, {
        draftOrderId: shopify.draftOrderId,
        shopifyInvoiceSent: shopify.shopifyInvoiceSent,
      });
      await this.appendAggregatedPaymentRecipientsToCallSession(args.callSid, {
        tenantId: args.tenantId,
        agentId: args.agentId,
        recipientEmail: args.email,
        paymentLink: shopify.invoiceUrl,
        draftOrderId: shopify.draftOrderId,
        checkoutLinkId: checkoutLink.id,
        productIds: resolvedLineItems.map((line) => line.productId),
        workingRecipients: checkoutPlan.workingRecipients,
        batches: {
          ...args.sessionState.batches,
          [normalizeRecipientEmail(args.email)]: invoicedBatch,
        },
      });
    }

    return {
      success: true,
      message: 'Payment link sent successfully.',
      agentMessage: buildAggregatedPaymentAgentMessage(resolvedLineItems.length),
      draftOrderId: shopify.draftOrderId,
      delivery: {
        email: delivery.email,
        sms: delivery.sms,
        whatsapp: delivery.whatsapp,
      },
      deliveryAttemptId: delivery.deliveryId,
      emailGate: args.gate.debug,
      latencyMs,
    };
  }

  private async sendAggregatedDraftOrderWithEmailRetry(
    tenantId: string,
    agentId: string,
    email: string,
    payload: {
      lines: Array<{ variantId: string; quantity: number }>;
      existingDraftOrderId?: string | null;
      sendShopifyInvoice?: boolean;
    },
  ): Promise<DraftOrderPaymentLinkResult> {
    try {
      return await this.draftOrders.sendAggregatedDraftOrderPaymentLink(tenantId, agentId, {
        email,
        ...payload,
      });
    } catch (err) {
      if (!(err instanceof ShopifyCheckoutValidationError)) throw err;
      if (!isShopifyInvalidEmailDomainError(err.message)) throw err;

      const typo = suggestEmailTypo(email);
      if (!typo || typo.correctedEmail === email) throw err;

      this.logger.warn(
        JSON.stringify({
          event: 'voice.payment.shopify_email_typo_retry',
          originalEmail: email,
          normalizedEmail: typo.correctedEmail,
          domain: extractEmailDomain(email),
          validationResult: err.message,
          validationSource: 'shopify_graphql',
          correctedDomain: typo.toDomain,
        }),
      );

      return this.draftOrders.sendAggregatedDraftOrderPaymentLink(tenantId, agentId, {
        email: typo.correctedEmail,
        ...payload,
      });
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

  private async loadCallSessionCheckoutState(args: {
    callSid: string | null | undefined;
    tenantId: string;
    agentId: string;
    email: string;
  }): Promise<{
    recipients: ReturnType<typeof parsePaymentRecipients>;
    batches: ReturnType<typeof parseEmailCheckoutBatches>;
  }> {
    const callSid = args.callSid?.trim();
    if (!callSid) return { recipients: [], batches: {} };

    await this.ensureCallSessionForCheckout(callSid, args.tenantId, args.agentId);

    const session = await this.prisma.callSession.findFirst({
      where: { twilioCallSid: callSid },
      select: { metadata: true },
    });
    const meta =
      session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    const sessionRecipients = parsePaymentRecipients(meta[PAYMENT_RECIPIENTS_METADATA_KEY]);
    const sessionBatches = parseEmailCheckoutBatches(meta[EMAIL_CHECKOUT_BATCHES_KEY]);

    const recentCheckoutLinks = await this.prisma.checkoutLink.findMany({
      where: {
        tenantId: args.tenantId,
        agentId: args.agentId,
        customerEmail: args.email,
        createdAt: { gte: checkoutStateLookbackSince() },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        providerRef: true,
        checkoutUrl: true,
        customerEmail: true,
        itemsJson: true,
        metadata: true,
        status: true,
        sentAt: true,
        createdAt: true,
      },
    });
    const hydrated = hydrateCheckoutStateFromCheckoutLinks(
      recentCheckoutLinks.filter(
        (record) => extractCallSidFromCheckoutMetadata(record.metadata) === callSid,
      ),
      { callSid, email: args.email },
    );
    const merged = mergeCheckoutSessionState({
      sessionRecipients,
      sessionBatches,
      hydratedRecipients: hydrated.recipients,
      hydratedBatches: hydrated.batches,
    });
    if (merged.hydrated) {
      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.checkout_state_hydrated',
          callSid,
          maskedEmail: maskEmailForLog(args.email),
          recipientCount: merged.recipients.length,
          batchCount: Object.keys(merged.batches).length,
        }),
      );
    }
    return {
      recipients: merged.recipients,
      batches: merged.batches,
    };
  }

  private async ensureCallSessionForCheckout(
    callSid: string,
    tenantId: string,
    agentId: string,
  ): Promise<void> {
    const existing = await this.prisma.callSession.findFirst({
      where: { twilioCallSid: callSid },
      select: { id: true },
    });
    if (existing) return;

    const inbound = await this.prisma.inboundCall.findUnique({
      where: { callSid },
      select: { callerPhone: true, twilioNumber: true },
    });

    try {
      const created = await this.prisma.callSession.create({
        data: {
          tenantId,
          agentId,
          twilioCallSid: callSid,
          fromNumber: inbound?.callerPhone,
          toNumber: inbound?.twilioNumber,
          direction: 'inbound',
          status: CallStatus.IN_PROGRESS,
          startedAt: new Date(),
        },
        select: { id: true },
      });
      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.call_session_ensured',
          callSid,
          callSessionId: created.id,
          source: 'elevenlabs_inbound',
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const raced = await this.prisma.callSession.findFirst({
        where: { twilioCallSid: callSid },
        select: { id: true },
      });
      if (raced) return;
      this.logger.warn(
        JSON.stringify({
          event: 'voice.payment.call_session_ensure_failed',
          callSid,
          message: message.slice(0, 300),
        }),
      );
    }
  }

  private async persistCheckoutBatchToCallSession(
    callSid: string,
    args: {
      tenantId: string;
      agentId: string;
      email: string;
      batch: ReturnType<typeof parseEmailCheckoutBatches>[string];
      workingRecipients: ReturnType<typeof parsePaymentRecipients>;
    },
  ): Promise<number> {
    await this.ensureCallSessionForCheckout(callSid, args.tenantId, args.agentId);
    const session = await this.prisma.callSession.findFirst({
      where: { twilioCallSid: callSid },
      select: { id: true, metadata: true },
    });
    if (!session) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.payment.batch_persist_skipped',
          reason: 'no_call_session',
          callSid,
          maskedEmail: maskEmailForLog(args.email),
        }),
      );
      return args.batch.lines.length;
    }
    const meta =
      session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    const normalizedEmail = normalizeRecipientEmail(args.email);
    const existingBatches = parseEmailCheckoutBatches(meta[EMAIL_CHECKOUT_BATCHES_KEY]);
    let mergedBatch = existingBatches[normalizedEmail] ?? {
      recipientEmail: normalizedEmail,
      draftOrderId: null,
      shopifyInvoiceSent: false,
      lines: [],
      status: 'accumulating' as const,
    };
    for (const line of args.batch.lines) {
      mergedBatch = registerLineToEmailBatch(mergedBatch, line);
    }
    const batches = {
      ...existingBatches,
      [normalizedEmail]: mergedBatch,
    };
    await this.prisma.callSession.update({
      where: { id: session.id },
      data: {
        metadata: {
          ...meta,
          ...sessionMetaPatchForRecipients(args.workingRecipients),
          ...sessionMetaPatchForEmailBatches(batches),
          orderState: 'PAYMENT_LINK_CREATING',
        } as Prisma.InputJsonValue,
      },
    });
    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.batch_persisted',
        callSid,
        maskedEmail: maskEmailForLog(args.email),
        aggregatedLineCount: mergedBatch.lines.length,
      }),
    );
    return mergedBatch.lines.length;
  }

  private async appendAggregatedPaymentRecipientsToCallSession(
    callSid: string,
    args: {
      tenantId: string;
      agentId: string;
      recipientEmail: string;
      paymentLink: string;
      draftOrderId: string;
      checkoutLinkId: string;
      productIds: string[];
      workingRecipients: ReturnType<typeof parsePaymentRecipients>;
      batches: ReturnType<typeof parseEmailCheckoutBatches>;
    },
  ): Promise<void> {
    await this.ensureCallSessionForCheckout(callSid, args.tenantId, args.agentId);
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
    const mergedSource = recipients.length ? recipients : args.workingRecipients;
    const updated = recipientsAfterAggregatedSend(mergedSource, args.recipientEmail, {
      paymentLink: args.paymentLink,
      draftOrderId: args.draftOrderId,
      checkoutLinkId: args.checkoutLinkId,
      productIds: args.productIds,
    });
    await this.prisma.callSession.update({
      where: { id: session.id },
      data: {
        metadata: {
          ...meta,
          ...sessionMetaPatchForRecipients(updated),
          ...sessionMetaPatchForEmailBatches(args.batches),
          orderState: 'PAYMENT_LINK_SENT',
        } as Prisma.InputJsonValue,
      },
    });
    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.recipient_persisted',
        callSid,
        maskedEmail: maskEmailForLog(args.recipientEmail),
        recipientCount: updated.length,
        aggregatedProductCount: args.productIds.length,
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
    lineItems: Array<{ title: string; quantity: number; price: string | null; variantId: string }>;
    callSid?: string;
    aggregationMode?: 'queue' | 'create' | 'update' | 'duplicate_prevented';
    shopifyInvoiceSent?: boolean;
  }) {
    const fingerprint = createHash('sha256')
      .update(
        [
          args.tenantId,
          args.agentId,
          args.draftOrderId,
          args.email,
          ...args.lineItems
            .map((line) => `${line.variantId}:${line.quantity}`)
            .sort(),
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
        itemsJson: args.lineItems.map((line) => ({
          title: line.title,
          quantity: line.quantity,
          price: line.price,
          variantId: line.variantId,
        })) as unknown as Prisma.InputJsonValue,
        providerRef: args.draftOrderId,
        status: 'CREATED',
        metadata: {
          source: 'voice_send_payment_link',
          draftOrderId: args.draftOrderId,
          callSid: args.callSid ?? null,
          aggregationMode: args.aggregationMode ?? 'create',
          lineCount: args.lineItems.length,
          shopifyInvoiceSent: args.shopifyInvoiceSent === true,
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
