import type { LlmAgentConversationState } from './llm-agent-conversation-state.util';
import { resolveCheckoutLineItemsFromLlmState } from './voice-checkout-flow.util';
import { shouldBlockCheckoutForOutOfStock, isLlmProductInStock } from './voice-stock-sales-policy.util';
import {
  buildEmailProcessingPrompt,
  buildPaymentEmailSendFailurePrompt,
  buildPaymentEmailSuccessPrompt,
  validateVoiceEmail,
} from './voice-email-capture.util';

export function shouldAutoTriggerCheckoutAfterEmail(
  state: LlmAgentConversationState,
  options: { emailConfirmedThisTurn: boolean },
): boolean {
  if (!options.emailConfirmedThisTurn) return false;
  if (state.paymentLinkSent === true || state.paymentLinkCreated === true) return false;

  const email = state.customerEmail?.trim();
  if (!email || !validateVoiceEmail(email).valid) return false;

  const lines = resolveCheckoutLineItemsFromLlmState(state);
  if (lines.length === 0 || lines.some((l) => !l.variantId || l.quantity < 1)) return false;

  const stockBlock = shouldBlockCheckoutForOutOfStock(state);
  if (stockBlock.blocked) return false;

  const active =
    state.selectedProducts.find((p) => isLlmProductInStock(p) && p.variantId) ??
    state.lastSearchedProducts.find((p) => isLlmProductInStock(p) && p.variantId);
  if (!active?.variantId) return false;

  const stage = state.checkoutStage;
  const stageReady =
    stage === 'quantity' ||
    stage === 'email' ||
    stage === 'product_selected' ||
    stage === 'payment';
  return stageReady;
}

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
  },
): LlmAgentConversationState {
  return {
    ...state,
    paymentLinkCreated: args.paymentLinkCreated,
    paymentLinkSent: args.paymentLinkSent,
    checkoutLinkId: args.checkoutLinkId ?? state.checkoutLinkId ?? null,
    checkoutUrl: args.checkoutUrl ?? state.checkoutUrl ?? null,
    checkoutStage: args.paymentLinkSent ? 'payment_sent' : 'payment',
    customerIntent: 'payment_link',
  };
}

export function buildAutoCheckoutConfirmationReply(args: {
  email: string;
  checkoutOk: boolean;
  emailOk: boolean;
  checkoutUrl?: string;
  emailSendFailureCount?: number;
}): string {
  if (args.checkoutOk && args.emailOk) {
    return `${buildEmailProcessingPrompt()} Your payment link has been sent successfully. Please check your inbox.`;
  }
  if (args.checkoutOk) {
    return buildPaymentEmailSendFailurePrompt(args.emailSendFailureCount ?? 1);
  }
  return "I'm having trouble generating the checkout link right now, but a human assistant will follow up shortly.";
}
