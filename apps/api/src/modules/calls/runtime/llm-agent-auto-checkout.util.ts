import type { LlmAgentConversationState } from './llm-agent-conversation-state.util';
import {
  activeProductAlreadySent,
  markRecipientEmailConfirmed,
  markRecipientPaymentSent,
  mergePaymentRecipientsIntoState,
  parsePaymentRecipients,
  resolveProductIdForRecipient,
} from './payment-recipient.util';
import { activeCheckoutProduct } from './transactional-checkout-state.util';
import { resolveCheckoutLineItemsFromLlmState } from './voice-checkout-flow.util';
import { shouldBlockCheckoutForOutOfStock, isLlmProductInStock } from './voice-stock-sales-policy.util';
import {
  buildPaymentEmailFallbackDeliveryPrompt,
  buildPaymentEmailSendFailurePrompt,
  buildPaymentEmailSuccessPrompt,
  isPaymentEmailDeliveryConfirmed,
  type PaymentEmailDeliveryResult,
  validateVoiceEmail,
} from './voice-email-capture.util';
import { canCreatePaymentLink, flowStateFromLlm } from './enterprise-checkout-state-machine.util';

/** Checkout only after explicit customer confirmation — never on email capture alone. */
export function shouldTriggerCheckoutAfterEmailConfirmed(
  state: LlmAgentConversationState,
  options: { emailConfirmedThisTurn: boolean },
): boolean {
  if (!options.emailConfirmedThisTurn) return false;

  const recipients = parsePaymentRecipients(state.paymentRecipients);
  const active = activeCheckoutProduct(state);
  if (active && activeProductAlreadySent(recipients, active, state.customerEmail)) {
    return false;
  }
  if (
    recipients.length === 0 &&
    (state.paymentLinkSent === true || state.paymentLinkCreated === true)
  ) {
    return false;
  }

  const flow = flowStateFromLlm(state, { emailConfirmationState: 'confirmed' });
  if (!canCreatePaymentLink(flow, state)) return false;

  const email = state.customerEmail?.trim();
  if (!email || !validateVoiceEmail(email).valid) return false;

  const lines = resolveCheckoutLineItemsFromLlmState(state);
  if (lines.length === 0 || lines.some((l) => !l.variantId || l.quantity < 1)) return false;

  const stockBlock = shouldBlockCheckoutForOutOfStock(state);
  if (stockBlock.blocked) return false;

  if (!active?.variantId) return false;

  const stage = state.checkoutStage;
  const stageReady =
    stage === 'quantity' ||
    stage === 'email' ||
    stage === 'product_selected' ||
    stage === 'payment';
  return stageReady;
}

/** @deprecated Use shouldTriggerCheckoutAfterEmailConfirmed */
export const shouldAutoTriggerCheckoutAfterEmail = shouldTriggerCheckoutAfterEmailConfirmed;

export function buildCreatePaymentLinkArgsFromState(
  state: LlmAgentConversationState,
): { email: string; items: Array<{ variantId: string; quantity: number }> } | null {
  const email = state.customerEmail?.trim();
  if (!email || !validateVoiceEmail(email).valid) return null;
  const lines = resolveCheckoutLineItemsFromLlmState(state);
  if (!lines.length) return null;
  return {
    email,
    items: lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
    })),
  };
}

export function applyPaymentFlowToState(
  state: LlmAgentConversationState,
  args: {
    checkoutLinkId?: string;
    checkoutUrl?: string;
    paymentLinkCreated: boolean;
    paymentLinkSent: boolean;
    draftOrderId?: string;
  },
): LlmAgentConversationState {
  let next: LlmAgentConversationState = {
    ...state,
    paymentLinkCreated: args.paymentLinkCreated,
    paymentLinkSent: args.paymentLinkSent,
    checkoutLinkId: args.checkoutLinkId ?? state.checkoutLinkId ?? null,
    checkoutUrl: args.checkoutUrl ?? state.checkoutUrl ?? null,
    checkoutStage: args.paymentLinkSent ? 'payment_sent' : 'payment',
    customerIntent: 'payment_link',
  };
  const product = activeCheckoutProduct(state);
  const email = state.customerEmail?.trim();
  if (product && email && args.paymentLinkSent) {
    const productId = resolveProductIdForRecipient(product);
    const qty =
      product.variantId && state.quantities[product.variantId]
        ? state.quantities[product.variantId]!
        : 1;
    let recipients = parsePaymentRecipients(state.paymentRecipients);
    recipients = markRecipientEmailConfirmed(recipients, product, email, qty);
    recipients = markRecipientPaymentSent(recipients, productId, email, {
      paymentLink: args.checkoutUrl ?? null,
      draftOrderId: args.draftOrderId,
      checkoutLinkId: args.checkoutLinkId,
    });
    next = mergePaymentRecipientsIntoState(next, recipients);
  }
  return next;
}

export function buildConfirmedEmailCheckoutReply(args: {
  email: string;
  checkoutOk: boolean;
  emailOk: boolean;
  emailApiResult?: PaymentEmailDeliveryResult | null;
  checkoutUrl?: string;
  emailSendFailureCount?: number;
}): string {
  const deliveryConfirmed = isPaymentEmailDeliveryConfirmed(
    args.emailApiResult ??
      (args.emailOk
        ? {
            success: true,
            smtpAccepted: true,
            providerSuccess: true,
            deliveryQueued: true,
          }
        : {
            success: false,
            smtpAccepted: false,
            providerSuccess: false,
            deliveryQueued: false,
          }),
  );
  if (args.checkoutOk && deliveryConfirmed) {
    return buildPaymentEmailSuccessPrompt();
  }
  if (args.checkoutOk) {
    const failures = args.emailSendFailureCount ?? 1;
    if (failures >= 2) {
      return buildPaymentEmailFallbackDeliveryPrompt();
    }
    return buildPaymentEmailSendFailurePrompt(failures);
  }
  return "I'm having trouble generating the checkout link right now, but a human assistant will follow up shortly.";
}

/** @deprecated Use buildConfirmedEmailCheckoutReply */
export const buildAutoCheckoutConfirmationReply = buildConfirmedEmailCheckoutReply;
