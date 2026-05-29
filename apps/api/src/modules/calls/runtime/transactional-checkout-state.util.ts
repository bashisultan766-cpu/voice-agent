import type { LlmAgentConversationState, LlmSelectedProduct } from './llm-agent-conversation-state.util';
import { isLlmProductInStock } from './voice-stock-sales-policy.util';
import { QUANTITY_PROMPT } from './book-sales-voice.util';
import {
  buildEmailCollectionPrompt,
  buildEmailConfirmationPrompt,
  buildInvalidEmailRetryPrompt,
  containsPaymentSuccessClaim,
  isDeterministicTransactionalReply,
  shouldOfferEmailRetry,
} from './voice-email-capture.util';

/** Hard transactional checkout states — LLM must not speak during these. */
export type TransactionalCheckoutState =
  | 'INACTIVE'
  | 'QUANTITY_COLLECTION_REQUIRED'
  | 'EMAIL_COLLECTION_REQUIRED'
  | 'EMAIL_CAPTURED'
  | 'EMAIL_CONFIRMATION_REQUIRED'
  | 'EMAIL_CONFIRMED'
  | 'PAYMENT_LINK_CREATING'
  | 'PAYMENT_LINK_SENT';

export const TRANSACTIONAL_CHECKOUT_STATE_KEY = 'transactionalCheckoutState';

export type TransactionalCheckoutContext = {
  llmState: LlmAgentConversationState;
  emailConfirmationState?: 'pending' | 'confirmed' | 'none' | null;
  collectedEmail?: string | null;
  orderState?: string | null;
  emailRetryCount?: number;
};

export function normalizeEmailConfirmationState(
  state?: 'pending' | 'confirmed' | 'none' | null,
): 'pending' | 'confirmed' | null {
  if (state === 'pending' || state === 'confirmed') return state;
  return null;
}

export type TransactionalRouteInput = TransactionalCheckoutContext & {
  userMessage: string;
  emailCapturedReply?: string | null;
  emailConfirmedThisTurn?: boolean;
};

export type TransactionalRouteResult = {
  handled: boolean;
  reply: string | null;
  skipOpenAiGeneration: boolean;
  transactionalState: TransactionalCheckoutState;
  deterministicReplyUsed: boolean;
  statePatch?: Partial<LlmAgentConversationState>;
  sessionMetaPatch?: Record<string, unknown>;
};

const FORBIDDEN_CHECKOUT_PHRASES: RegExp[] = [
  /\bshare your email\b/i,
  /\bprovide your email\b/i,
  /\bgive me your email\b/i,
  /\bwhat(?:'s| is) your email\b/i,
  /\bprepare the payment link\b/i,
  /\bi(?:'ll| will) prepare the payment link\b/i,
  /\bi(?:'ll| will) send the payment link right away\b/i,
  /\bsend the payment link right away\b/i,
  /\bcheck your inbox\b/i,
  /\bpayment link has been sent\b/i,
];

export function activeCheckoutProduct(
  state: LlmAgentConversationState,
): LlmSelectedProduct | undefined {
  return (
    state.selectedProducts.find((p) => isLlmProductInStock(p) && p.variantId) ??
    state.lastSearchedProducts.find((p) => isLlmProductInStock(p) && p.variantId)
  );
}

export function hasSelectedInStockProduct(state: LlmAgentConversationState): boolean {
  return activeCheckoutProduct(state) != null;
}

export function resolveLineQuantity(state: LlmAgentConversationState): number {
  const product = activeCheckoutProduct(state);
  if (!product?.variantId) return 0;
  return Math.max(0, Number(state.quantities[product.variantId] ?? 0));
}

export function isCheckoutCartReady(state: LlmAgentConversationState): boolean {
  return hasSelectedInStockProduct(state) && resolveLineQuantity(state) > 0;
}

export function applyDeterministicProductSelection(
  state: LlmAgentConversationState,
): LlmAgentConversationState {
  if (state.selectedProducts.some((p) => isLlmProductInStock(p) && p.variantId)) {
    return { ...state, checkoutStage: 'product_selected' };
  }
  const pick =
    state.lastSearchedProducts.find((p) => isLlmProductInStock(p) && p.variantId) ??
    state.lastSearchedProducts.find((p) => p.variantId);
  if (!pick) return state;
  return {
    ...state,
    selectedProducts: [pick],
    checkoutStage: 'product_selected',
    customerIntent: 'product_selected',
  };
}

export function resolveTransactionalCheckoutState(
  ctx: TransactionalCheckoutContext,
): TransactionalCheckoutState {
  const { llmState, collectedEmail, orderState } = ctx;
  const emailConfirmationState = normalizeEmailConfirmationState(ctx.emailConfirmationState);

  if (llmState.paymentLinkSent === true || orderState === 'PAYMENT_LINK_SENT') {
    return 'PAYMENT_LINK_SENT';
  }
  if (orderState === 'PAYMENT_LINK_CREATING' || llmState.paymentLinkCreated === true) {
    return 'PAYMENT_LINK_CREATING';
  }
  if (emailConfirmationState === 'confirmed' || orderState === 'EMAIL_CONFIRMED') {
    return 'EMAIL_CONFIRMED';
  }
  if (
    emailConfirmationState === 'pending' &&
    collectedEmail?.trim()
  ) {
    return 'EMAIL_CONFIRMATION_REQUIRED';
  }
  if (llmState.customerEmail?.trim() && emailConfirmationState == null) {
    return 'EMAIL_CAPTURED';
  }

  if (!hasSelectedInStockProduct(llmState)) {
    return 'INACTIVE';
  }

  if (resolveLineQuantity(llmState) < 1) {
    return 'QUANTITY_COLLECTION_REQUIRED';
  }

  if (
    llmState.checkoutStage === 'product_selected' ||
    llmState.checkoutStage === 'quantity' ||
    llmState.checkoutStage === 'email' ||
    llmState.checkoutStage === 'payment'
  ) {
    return 'EMAIL_COLLECTION_REQUIRED';
  }

  return 'INACTIVE';
}

export function isTransactionalCheckoutActive(state: TransactionalCheckoutState): boolean {
  return state !== 'INACTIVE';
}

export function shouldBypassOpenAiGeneration(state: TransactionalCheckoutState): boolean {
  return (
    state === 'QUANTITY_COLLECTION_REQUIRED' ||
    state === 'EMAIL_COLLECTION_REQUIRED' ||
    state === 'EMAIL_CAPTURED' ||
    state === 'EMAIL_CONFIRMATION_REQUIRED' ||
    state === 'EMAIL_CONFIRMED' ||
    state === 'PAYMENT_LINK_CREATING'
  );
}

export function containsForbiddenCheckoutPhrase(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return FORBIDDEN_CHECKOUT_PHRASES.some((re) => re.test(t));
}

export function guardTransactionalReply(
  reply: string,
  args: {
    transactionalState: TransactionalCheckoutState;
    deliveryConfirmed?: boolean;
    emailRetryCount?: number;
    pendingEmail?: string | null;
  },
): string {
  const trimmed = reply.trim();
  if (!trimmed) return buildEmailCollectionPrompt(args.emailRetryCount ?? 0);

  const mustGuard =
    shouldBypassOpenAiGeneration(args.transactionalState) ||
    containsForbiddenCheckoutPhrase(trimmed) ||
    (containsPaymentSuccessClaim(trimmed) && args.deliveryConfirmed !== true);

  if (!mustGuard) return trimmed;

  if (containsPaymentSuccessClaim(trimmed) && args.deliveryConfirmed !== true) {
    if (
      args.transactionalState === 'EMAIL_CONFIRMED' ||
      args.transactionalState === 'PAYMENT_LINK_CREATING' ||
      isDeterministicTransactionalReply(trimmed)
    ) {
      return trimmed;
    }
    if (args.transactionalState === 'EMAIL_CONFIRMATION_REQUIRED' && args.pendingEmail) {
      return buildEmailConfirmationPrompt(args.pendingEmail);
    }
    return buildEmailCollectionPrompt(args.emailRetryCount ?? 0);
  }

  if (containsForbiddenCheckoutPhrase(trimmed)) {
    switch (args.transactionalState) {
      case 'EMAIL_CONFIRMATION_REQUIRED':
      case 'EMAIL_CAPTURED':
        return args.pendingEmail
          ? buildEmailConfirmationPrompt(args.pendingEmail)
          : buildEmailCollectionPrompt(args.emailRetryCount ?? 0);
      case 'QUANTITY_COLLECTION_REQUIRED':
        return QUANTITY_PROMPT;
      default:
        return buildEmailCollectionPrompt(args.emailRetryCount ?? 0);
    }
  }

  return trimmed;
}

export function routeTransactionalCheckoutTurn(
  input: TransactionalRouteInput,
): TransactionalRouteResult {
  const emailRetryCount = input.emailRetryCount ?? 0;
  let transactionalState = resolveTransactionalCheckoutState(input);

  if (input.emailCapturedReply?.trim()) {
    return {
      handled: true,
      reply: input.emailCapturedReply,
      skipOpenAiGeneration: true,
      transactionalState:
        transactionalState === 'INACTIVE' ? 'EMAIL_CONFIRMATION_REQUIRED' : transactionalState,
      deterministicReplyUsed: true,
    };
  }

  if (input.emailConfirmedThisTurn) {
    return {
      handled: false,
      reply: null,
      skipOpenAiGeneration: true,
      transactionalState: 'EMAIL_CONFIRMED',
      deterministicReplyUsed: false,
    };
  }

  if (!shouldBypassOpenAiGeneration(transactionalState)) {
    return {
      handled: false,
      reply: null,
      skipOpenAiGeneration: false,
      transactionalState,
      deterministicReplyUsed: false,
    };
  }

  if (transactionalState === 'QUANTITY_COLLECTION_REQUIRED') {
    return {
      handled: true,
      reply: QUANTITY_PROMPT,
      skipOpenAiGeneration: true,
      transactionalState,
      deterministicReplyUsed: true,
      statePatch: { checkoutStage: 'product_selected', customerIntent: 'quantity_selection' },
      sessionMetaPatch: {
        [TRANSACTIONAL_CHECKOUT_STATE_KEY]: transactionalState,
        orderState: 'QUANTITY_COLLECTED',
      },
    };
  }

  if (transactionalState === 'EMAIL_COLLECTION_REQUIRED') {
    const reply = buildEmailCollectionPrompt(emailRetryCount);
    return {
      handled: true,
      reply,
      skipOpenAiGeneration: true,
      transactionalState,
      deterministicReplyUsed: true,
      statePatch: { checkoutStage: 'email', customerIntent: 'email_collection' },
      sessionMetaPatch: {
        [TRANSACTIONAL_CHECKOUT_STATE_KEY]: transactionalState,
        orderState: 'EMAIL_COLLECTING',
      },
    };
  }

  if (
    transactionalState === 'EMAIL_CONFIRMATION_REQUIRED' ||
    transactionalState === 'EMAIL_CAPTURED'
  ) {
    const pending = input.collectedEmail?.trim() || input.llmState.customerEmail?.trim() || '';
    return {
      handled: true,
      reply: pending
        ? buildEmailConfirmationPrompt(pending)
        : buildEmailCollectionPrompt(emailRetryCount),
      skipOpenAiGeneration: true,
      transactionalState: 'EMAIL_CONFIRMATION_REQUIRED',
      deterministicReplyUsed: true,
      sessionMetaPatch: {
        [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'EMAIL_CONFIRMATION_REQUIRED',
        orderState: 'EMAIL_CONFIRMING',
      },
    };
  }

  if (transactionalState === 'EMAIL_CONFIRMED' || transactionalState === 'PAYMENT_LINK_CREATING') {
    return {
      handled: false,
      reply: null,
      skipOpenAiGeneration: true,
      transactionalState,
      deterministicReplyUsed: false,
    };
  }

  return {
    handled: false,
    reply: null,
    skipOpenAiGeneration: shouldBypassOpenAiGeneration(transactionalState),
    transactionalState,
    deterministicReplyUsed: false,
  };
}

export function buildTransactionalCheckoutLog(args: {
  callSessionId?: string;
  tenantId?: string;
  agentId?: string;
  transactionalMode: boolean;
  checkoutState: TransactionalCheckoutState;
  deterministicReplyUsed: boolean;
  skipOpenAiGeneration?: boolean;
  llmCheckoutStage?: string;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: args.transactionalMode
      ? 'transactional_checkout_mode_activated'
      : 'transactional_checkout_mode_inactive',
    transactionalMode: args.transactionalMode,
    checkoutState: args.checkoutState,
    deterministicReplyUsed: args.deterministicReplyUsed,
    ...(args.skipOpenAiGeneration != null ? { skipOpenAiGeneration: args.skipOpenAiGeneration } : {}),
    ...(args.llmCheckoutStage ? { llmCheckoutStage: args.llmCheckoutStage } : {}),
    ...(args.callSessionId ? { callSessionId: args.callSessionId } : {}),
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
  };
  return base;
}
