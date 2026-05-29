/**
 * Enterprise voice checkout state machine — deterministic guards and journey logging.
 */
import type { LlmAgentConversationState } from './llm-agent-conversation-state.util';
import {
  CheckoutState,
  type EnterpriseCheckoutState,
} from './checkout-state.types';
import { validateVoiceEmail } from './voice-email-capture.util';
import { hasSelectedInStockProduct, resolveLineQuantity } from './transactional-checkout-state.util';

export type { EnterpriseCheckoutState } from './checkout-state.types';
export { CheckoutState, assertValidCheckoutState, isVoiceCheckoutState } from './checkout-state.types';

export type EnterpriseCheckoutFlowState = {
  productSelected: boolean;
  quantityConfirmed: boolean;
  emailValidated: boolean;
  emailConfirmed: boolean;
  paymentLinkSent?: boolean;
  emailSendFailureCount?: number;
};

export type EnterpriseCheckoutLogEvent =
  | 'language_detected'
  | 'product_selected'
  | 'quantity_confirmed'
  | 'email_requested'
  | 'email_captured'
  | 'email_validation_started'
  | 'email_validation_passed'
  | 'email_validation_failed'
  | 'email_confirmation_required'
  | 'email_inline_confirmation_detected'
  | 'email_confirmation_rejected'
  | 'negative_confirmation_detected'
  | 'email_recollection_started'
  | 'customer_confirmed_email'
  | 'payment_link_created'
  | 'payment_email_send_started'
  | 'payment_email_delivery_confirmed'
  | 'checkout_completed'
  | 'voice_provider_enforced';

export function buildEnterpriseCheckoutLog(
  event: EnterpriseCheckoutLogEvent,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { event, ...fields };
}

export function flowStateFromLlm(
  state: LlmAgentConversationState,
  meta: {
    emailConfirmationState?: 'pending' | 'confirmed' | null;
    emailEnterpriseValidated?: boolean;
    emailSendFailureCount?: number;
  } = {},
): EnterpriseCheckoutFlowState {
  const email = state.customerEmail?.trim() ?? '';
  const emailValidated =
    meta.emailEnterpriseValidated === true ||
    (email.length > 0 && validateVoiceEmail(email).valid);
  return {
    productSelected: hasSelectedInStockProduct(state),
    quantityConfirmed: resolveLineQuantity(state) > 0,
    emailValidated,
    emailConfirmed: meta.emailConfirmationState === 'confirmed',
    paymentLinkSent: state.paymentLinkSent === true,
    emailSendFailureCount: meta.emailSendFailureCount,
  };
}

/** Hard guard — never create payment link before confirmed email (spec §9). */
export function canCreatePaymentLink(flow: EnterpriseCheckoutFlowState): boolean {
  return (
    flow.productSelected &&
    flow.quantityConfirmed &&
    flow.emailValidated &&
    flow.emailConfirmed
  );
}

export type EmailConfirmationState = 'pending' | 'confirmed' | 'rejected' | 'none' | null;

export function isEmailExplicitlyConfirmed(state: EmailConfirmationState | undefined): boolean {
  return state === 'confirmed';
}

/** Hard guard — checkout must never run without explicit positive confirmation. */
export function assertEmailConfirmedBeforeCheckout(
  emailConfirmationState: EmailConfirmationState | undefined,
): void {
  if (!isEmailExplicitlyConfirmed(emailConfirmationState)) {
    throw new Error(
      'CRITICAL: checkout attempted without explicit positive email confirmation',
    );
  }
}

export function resolveEnterpriseCheckoutStateAfterConfirmation(
  flow: EnterpriseCheckoutFlowState,
  llmState: LlmAgentConversationState,
  emailConfirmationState: EmailConfirmationState,
): EnterpriseCheckoutState {
  if (emailConfirmationState === 'rejected') {
    return flow.productSelected && flow.quantityConfirmed
      ? CheckoutState.EMAIL_COLLECTION_REQUIRED
      : CheckoutState.EMAIL_REQUESTED;
  }
  return resolveEnterpriseCheckoutState(flow, llmState);
}

export function resolveEnterpriseCheckoutState(
  flow: EnterpriseCheckoutFlowState,
  llmState: LlmAgentConversationState,
): EnterpriseCheckoutState {
  if (flow.paymentLinkSent) return CheckoutState.CHECKOUT_COMPLETED;
  if ((flow.emailSendFailureCount ?? 0) >= 2 && !flow.paymentLinkSent) {
    return CheckoutState.FALLBACK_DELIVERY_REQUIRED;
  }
  if (llmState.paymentLinkCreated && !flow.paymentLinkSent) {
    return CheckoutState.PAYMENT_EMAIL_SENDING;
  }
  if (flow.emailConfirmed && !llmState.paymentLinkCreated) {
    return CheckoutState.PAYMENT_LINK_CREATING;
  }
  if (flow.emailConfirmed) return CheckoutState.EMAIL_CONFIRMED;
  if (flow.emailValidated && !flow.emailConfirmed) {
    return CheckoutState.EMAIL_CONFIRMATION_REQUIRED;
  }
  if (flow.productSelected && !flow.quantityConfirmed) return CheckoutState.QUANTITY_REQUIRED;
  if (flow.productSelected && flow.quantityConfirmed && !flow.emailValidated) {
    return CheckoutState.EMAIL_REQUESTED;
  }
  if (flow.productSelected) return CheckoutState.PRODUCT_SELECTED;
  return CheckoutState.IDLE;
}

export function shouldBypassOpenAiForEnterpriseState(
  state: EnterpriseCheckoutState,
): boolean {
  return (
    state !== CheckoutState.IDLE &&
    state !== CheckoutState.LANGUAGE_DETECTED &&
    state !== CheckoutState.CHECKOUT_COMPLETED
  );
}
