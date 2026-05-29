import {
  buildCheckoutProductConfirmedPrompt,
  buildEmailCollectionPrompt,
  buildEmailConfirmationPrompt,
  buildInvalidEmailRetryPrompt,
  containsPaymentSuccessClaim,
  extractEmailFromSpeech,
  isDeterministicTransactionalReply,
  PRODUCT_CHECKOUT_INTRODUCED_KEY,
  shouldOfferEmailRetry,
} from './voice-email-capture.util';
import {
  mergeCallerSignalsIntoState,
  type LlmAgentConversationState,
  type LlmSelectedProduct,
} from './llm-agent-conversation-state.util';
import { isLlmProductInStock } from './voice-stock-sales-policy.util';
import { QUANTITY_PROMPT } from './book-sales-voice.util';

/** Hard transactional checkout states — LLM must not speak during these. */
export type TransactionalCheckoutState =
  | 'INACTIVE'
  | 'PRODUCT_CONFIRMED'
  | 'QUANTITY_COLLECTION_REQUIRED'
  | 'EMAIL_COLLECTION_REQUIRED'
  | 'EMAIL_CAPTURED'
  | 'EMAIL_VALIDATED'
  | 'EMAIL_CONFIRMATION_REQUIRED'
  | 'EMAIL_CONFIRMED'
  | 'PAYMENT_LINK_CREATING'
  | 'PAYMENT_LINK_SENT';

export const TRANSACTIONAL_CHECKOUT_STATE_KEY = 'transactionalCheckoutState';
export const CHECKOUT_LOCK_ACTIVE_KEY = 'CHECKOUT_LOCK_ACTIVE';

const SPOKEN_QUANTITY_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export type TransactionalCheckoutContext = {
  llmState: LlmAgentConversationState;
  emailConfirmationState?: 'pending' | 'confirmed' | 'none' | null;
  collectedEmail?: string | null;
  orderState?: string | null;
  emailRetryCount?: number;
  emailEnterpriseValidated?: boolean;
  productCheckoutIntroduced?: boolean;
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

/** Parse quantity from spoken checkout utterances (e.g. "just one copy for this"). */
export function parseCheckoutQuantityFromSpeech(text: string): number | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;

  const digitCopy = t.match(/\b(\d{1,2})\s*(?:copies|copy|books?)\b/);
  if (digitCopy) {
    const n = Number(digitCopy[1]);
    return Number.isFinite(n) && n > 0 ? Math.min(99, n) : null;
  }

  for (const [word, n] of Object.entries(SPOKEN_QUANTITY_WORDS)) {
    if (new RegExp(`\\b${word}\\s+(?:copies|copy|books?)\\b`, 'i').test(t)) {
      return n;
    }
  }

  if (/\b(?:just|only)\s+one\b/i.test(t) || /\bone\s+(?:copy|book)\b/i.test(t)) {
    return 1;
  }

  const bare = t.match(/\b(\d{1,3})\b/);
  if (bare && t.split(/\s+/).length <= 4) {
    const n = Number(bare[1]);
    return Number.isFinite(n) && n > 0 ? Math.min(99, n) : null;
  }

  return null;
}

/** Caller affirms product / quantity during checkout (not a new catalog search). */
export function isCheckoutProductAffirmation(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  if (parseCheckoutQuantityFromSpeech(text) != null) return true;
  return /\b(yes|yeah|yep|sure|ok|okay|order|buy|this one|that one|for this|first one|i want|i'll take|ill take|add it|get it)\b/i.test(
    t,
  );
}

/** True when utterance must not be routed as product_search / product_discovery. */
export function isCheckoutLockedUtterance(text: string, state: LlmAgentConversationState): boolean {
  if (extractEmailFromSpeech(text)) return false;
  if (!state.lastSearchedProducts.length && !state.selectedProducts.length) return false;
  return isCheckoutProductAffirmation(text) || parseCheckoutQuantityFromSpeech(text) != null;
}

/**
 * Apply product + quantity from speech BEFORE intent classification / OpenAI.
 * PRODUCT_SELECTED → QUANTITY_CONFIRMED → EMAIL_COLLECTION_REQUIRED stage hints.
 */
export function applyCheckoutSignalsFromSpeech(
  state: LlmAgentConversationState,
  userMessage: string,
): LlmAgentConversationState {
  let next = state;
  const qty = parseCheckoutQuantityFromSpeech(userMessage);
  const affirm = isCheckoutProductAffirmation(userMessage);
  const hasCatalogContext =
    next.lastSearchedProducts.length > 0 || next.selectedProducts.length > 0;

  if (!hasCatalogContext) return next;

  if (affirm || qty != null) {
    next = applyDeterministicProductSelection(next);
  }

  if (qty != null) {
    next = mergeCallerSignalsIntoState(next, {
      quantity: qty,
      intentHint: 'quantity_selection',
    });
  }

  if (isCheckoutCartReady(next)) {
    next = {
      ...next,
      checkoutStage: 'email',
      customerIntent: 'email_collection',
      transactionalCheckoutState: 'EMAIL_COLLECTION_REQUIRED',
    };
  } else if (affirm || qty != null) {
    next = {
      ...next,
      customerIntent: qty != null ? 'quantity_selection' : 'product_selected',
      checkoutStage:
        next.checkoutStage === 'product_discovery' || next.checkoutStage === 'idle'
          ? 'product_selected'
          : next.checkoutStage,
    };
  }

  return next;
}

export type CheckoutLockEvaluation = {
  checkoutLockActive: boolean;
  transactionalCheckoutMode: boolean;
  activeProductSelected: boolean;
  quantityConfirmed: boolean;
  checkoutState: TransactionalCheckoutState;
  skipOpenAiGeneration: boolean;
  reply: string | null;
};

export type CheckoutLockContext = {
  awaitingEmailConfirmation?: boolean;
  emailCapturedThisTurn?: boolean;
  emailConfirmedThisTurn?: boolean;
  emailRetryCount?: number;
};

/** Hard checkout lock: product + quantity confirmed → email collection only. */
export function evaluateCheckoutLock(
  state: LlmAgentConversationState,
  ctx: CheckoutLockContext & { productCheckoutIntroduced?: boolean } = {},
): CheckoutLockEvaluation {
  const activeProductSelected = hasSelectedInStockProduct(state);
  const quantityConfirmed = resolveLineQuantity(state) > 0;
  const emailFlowActive =
    ctx.awaitingEmailConfirmation === true ||
    ctx.emailCapturedThisTurn === true ||
    ctx.emailConfirmedThisTurn === true ||
    Boolean(state.customerEmail?.trim());

  let checkoutState = resolveTransactionalCheckoutState({
    llmState: state,
    productCheckoutIntroduced: ctx.productCheckoutIntroduced,
  });

  if (activeProductSelected && quantityConfirmed && !emailFlowActive) {
    checkoutState = ctx.productCheckoutIntroduced
      ? 'EMAIL_COLLECTION_REQUIRED'
      : 'PRODUCT_CONFIRMED';
  }

  const checkoutLockActive =
    activeProductSelected && quantityConfirmed && !emailFlowActive;

  const skipOpenAiGeneration = checkoutLockActive || shouldBypassOpenAiGeneration(checkoutState);

  const reply = checkoutLockActive
    ? ctx.productCheckoutIntroduced
      ? buildEmailCollectionPrompt(ctx.emailRetryCount ?? 0, true)
      : buildCheckoutProductConfirmedPrompt()
    : checkoutState === 'QUANTITY_COLLECTION_REQUIRED'
      ? QUANTITY_PROMPT
      : null;

  return {
    checkoutLockActive,
    transactionalCheckoutMode: checkoutLockActive,
    activeProductSelected,
    quantityConfirmed,
    checkoutState,
    skipOpenAiGeneration,
    reply,
  };
}

export function assertNoOpenAiDuringTransactionalCheckout(args: {
  transactionalCheckoutMode: boolean;
  openaiCalled: boolean;
}): void {
  if (args.transactionalCheckoutMode && args.openaiCalled) {
    throw new Error('CRITICAL: OpenAI used during checkout flow');
  }
}

const EMERGENCY_LLM_CHECKOUT_PATTERNS: RegExp[] = [
  /\bpayment link\b/i,
  /\bemail address\b/i,
  /\bshare your email\b/i,
  /\bprovide your email\b/i,
];

/** Block LLM checkout phrasing when product is already selected. */
export function emergencyBlockLlmCheckoutReply(
  reply: string,
  args: { activeProductSelected: boolean; openaiCalled: boolean; emailRetryCount?: number },
): string {
  if (!args.activeProductSelected || !args.openaiCalled) return reply.trim();
  const t = reply.trim();
  if (!t) return buildEmailCollectionPrompt(args.emailRetryCount ?? 0);
  if (EMERGENCY_LLM_CHECKOUT_PATTERNS.some((re) => re.test(t))) {
    return buildEmailCollectionPrompt(args.emailRetryCount ?? 0);
  }
  return t;
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
  if (emailConfirmationState === 'pending' && collectedEmail?.trim()) {
    return 'EMAIL_CONFIRMATION_REQUIRED';
  }

  if (llmState.customerEmail?.trim() && emailConfirmationState == null) {
    return ctx.emailEnterpriseValidated === true ? 'EMAIL_VALIDATED' : 'EMAIL_CAPTURED';
  }

  if (!hasSelectedInStockProduct(llmState)) {
    return 'INACTIVE';
  }

  if (resolveLineQuantity(llmState) < 1) {
    if (
      llmState.checkoutProductAcknowledged !== true &&
      ctx.productCheckoutIntroduced !== true
    ) {
      return 'PRODUCT_CONFIRMED';
    }
    return 'QUANTITY_COLLECTION_REQUIRED';
  }

  if (isCheckoutCartReady(llmState)) {
    if (
      ctx.productCheckoutIntroduced !== true &&
      llmState.checkoutProductAcknowledged !== true
    ) {
      return 'PRODUCT_CONFIRMED';
    }
    return 'EMAIL_COLLECTION_REQUIRED';
  }

  return 'INACTIVE';
}

export function isTransactionalCheckoutActive(state: TransactionalCheckoutState): boolean {
  return state !== 'INACTIVE';
}

export function shouldBypassOpenAiGeneration(state: TransactionalCheckoutState): boolean {
  return (
    state === 'PRODUCT_CONFIRMED' ||
    state === 'QUANTITY_COLLECTION_REQUIRED' ||
    state === 'EMAIL_COLLECTION_REQUIRED' ||
    state === 'EMAIL_CAPTURED' ||
    state === 'EMAIL_VALIDATED' ||
    state === 'EMAIL_CONFIRMATION_REQUIRED' ||
    state === 'EMAIL_CONFIRMED' ||
    state === 'PAYMENT_LINK_CREATING' ||
    state === 'PAYMENT_LINK_SENT'
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
      isDeterministicTransactionalReply(trimmed) &&
      (args.transactionalState === 'PAYMENT_LINK_SENT' ||
        args.transactionalState === 'PAYMENT_LINK_CREATING')
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

  if (transactionalState === 'PRODUCT_CONFIRMED') {
    return {
      handled: true,
      reply: buildCheckoutProductConfirmedPrompt(),
      skipOpenAiGeneration: true,
      transactionalState,
      deterministicReplyUsed: true,
      statePatch: {
        checkoutStage: 'product_selected',
        customerIntent: 'product_selected',
        checkoutProductAcknowledged: true,
      },
      sessionMetaPatch: {
        [TRANSACTIONAL_CHECKOUT_STATE_KEY]: transactionalState,
        [PRODUCT_CHECKOUT_INTRODUCED_KEY]: true,
        orderState: 'PRODUCT_CONFIRMED',
      },
    };
  }

  if (transactionalState === 'QUANTITY_COLLECTION_REQUIRED') {
    return {
      handled: true,
      reply: QUANTITY_PROMPT,
      skipOpenAiGeneration: true,
      transactionalState,
      deterministicReplyUsed: true,
      statePatch: {
        checkoutStage: 'product_selected',
        customerIntent: 'quantity_selection',
        checkoutProductAcknowledged: true,
      },
      sessionMetaPatch: {
        [TRANSACTIONAL_CHECKOUT_STATE_KEY]: transactionalState,
        orderState: 'QUANTITY_COLLECTED',
      },
    };
  }

  if (transactionalState === 'EMAIL_COLLECTION_REQUIRED') {
    const reply = buildEmailCollectionPrompt(emailRetryCount, true);
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
    transactionalState === 'EMAIL_CAPTURED' ||
    transactionalState === 'EMAIL_VALIDATED'
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
  transactionalCheckoutMode?: boolean;
  checkoutState: TransactionalCheckoutState;
  deterministicReplyUsed: boolean;
  skipOpenAiGeneration?: boolean;
  activeProductSelected?: boolean;
  quantityConfirmed?: boolean;
  llmCheckoutStage?: string;
}): Record<string, unknown> {
  const transactionalCheckoutMode = args.transactionalCheckoutMode ?? args.transactionalMode;
  const base: Record<string, unknown> = {
    event: transactionalCheckoutMode
      ? 'transactional_checkout_mode_activated'
      : 'transactional_checkout_mode_inactive',
    transactionalMode: args.transactionalMode,
    transactionalCheckoutMode,
    checkoutState: args.checkoutState,
    deterministicReplyUsed: args.deterministicReplyUsed,
    ...(args.skipOpenAiGeneration != null ? { skipOpenAiGeneration: args.skipOpenAiGeneration } : {}),
    ...(args.activeProductSelected != null
      ? { activeProductSelected: args.activeProductSelected }
      : {}),
    ...(args.quantityConfirmed != null ? { quantityConfirmed: args.quantityConfirmed } : {}),
    ...(transactionalCheckoutMode ? { [CHECKOUT_LOCK_ACTIVE_KEY]: true } : {}),
    ...(args.llmCheckoutStage ? { llmCheckoutStage: args.llmCheckoutStage } : {}),
    ...(args.callSessionId ? { callSessionId: args.callSessionId } : {}),
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
  };
  return base;
}
