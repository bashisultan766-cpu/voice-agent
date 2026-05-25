import type { OrderState } from './order-state-machine.util';
import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { ObjectionType } from './objection-patterns.util';

/** Enterprise voice conversation stages (parallel to simplified orderState). */
export type ConversationStage =
  | 'GREETING'
  | 'DISCOVERY'
  | 'RECOMMENDATION'
  | 'OBJECTION_HANDLING'
  | 'CHECKOUT_CONFIRMATION'
  | 'PAYMENT_LINK_CONFIRMATION'
  | 'FOLLOW_UP';

const STAGE_ORDER: ConversationStage[] = [
  'GREETING',
  'DISCOVERY',
  'RECOMMENDATION',
  'OBJECTION_HANDLING',
  'CHECKOUT_CONFIRMATION',
  'PAYMENT_LINK_CONFIRMATION',
  'FOLLOW_UP',
];

export function normalizeConversationStage(value: unknown): ConversationStage {
  if (typeof value !== 'string') return 'GREETING';
  const v = value.trim().toUpperCase() as ConversationStage;
  return STAGE_ORDER.includes(v) ? v : 'GREETING';
}

export type StageTransitionInput = {
  currentStage: ConversationStage;
  orderState: OrderState;
  userIntent: UserUtteranceIntent;
  objection: ObjectionType | null;
  hasProductDiscussed: boolean;
  paymentLinkSent: boolean;
  emailConfirmed: boolean;
};

export type StageTransitionResult = {
  nextStage: ConversationStage;
  guidance: string;
};

/** Deterministic stage guidance injected into runtime context (not client-editable). */
export function stageGuidance(stage: ConversationStage): string {
  switch (stage) {
    case 'GREETING':
      return 'Greet warmly in one short sentence, then ask what they are looking for.';
    case 'DISCOVERY':
      return 'Ask one discovery question (genre, author, interest, budget). Do not list products without searching.';
    case 'RECOMMENDATION':
      return 'Recommend at most two in-stock titles from tools; highlight why it fits; soft upsell only if natural.';
    case 'OBJECTION_HANDLING':
      return 'Acknowledge concern; use retrieval or catalog tools; guide toward one confident next step to purchase.';
    case 'CHECKOUT_CONFIRMATION':
      return 'Confirm title, quantity, and variant before asking for email. One confirmation at a time.';
    case 'PAYMENT_LINK_CONFIRMATION':
      return 'Confirm email spelling, then confirm payment link was or will be sent. Offer resend once if asked.';
    case 'FOLLOW_UP':
      return 'Thank them, offer one brief follow-up (tracking, another title), then close politely.';
    default:
      return 'Keep responses under three short sentences.';
  }
}

export function advanceConversationStage(input: StageTransitionInput): StageTransitionResult {
  let next = input.currentStage;

  if (input.paymentLinkSent || input.orderState === 'DONE') {
    next = 'FOLLOW_UP';
  } else if (input.orderState === 'EMAIL_COLLECTION' || input.userIntent === 'email_provided') {
    next = input.emailConfirmed ? 'PAYMENT_LINK_CONFIRMATION' : 'CHECKOUT_CONFIRMATION';
  } else if (input.objection) {
    next = 'OBJECTION_HANDLING';
  } else if (
    input.userIntent === 'purchase_confirmation' ||
    input.userIntent === 'payment_question'
  ) {
    next = 'CHECKOUT_CONFIRMATION';
  } else if (
    input.userIntent === 'product_search' ||
    input.userIntent === 'product_question' ||
    input.hasProductDiscussed
  ) {
    next = input.userIntent === 'product_search' && !input.hasProductDiscussed
      ? 'DISCOVERY'
      : 'RECOMMENDATION';
  } else if (input.userIntent === 'greeting' || input.currentStage === 'GREETING') {
    next = 'GREETING';
  } else if (input.userIntent === 'small_talk') {
    next = input.hasProductDiscussed ? 'RECOMMENDATION' : 'DISCOVERY';
  } else {
    const idx = STAGE_ORDER.indexOf(input.currentStage);
    if (idx >= 0 && idx < STAGE_ORDER.length - 1 && input.hasProductDiscussed) {
      next = STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.indexOf('RECOMMENDATION'))] ?? 'DISCOVERY';
    }
  }

  return { nextStage: next, guidance: stageGuidance(next) };
}

/** Skip OpenAI for ultra-low-latency turns when no tools are needed. */
export function shouldUseFastVoicePath(
  userIntent: UserUtteranceIntent,
  stage: ConversationStage,
  toolCallAllowed: boolean,
): boolean {
  if (toolCallAllowed) return false;
  if (stage === 'GREETING' && (userIntent === 'greeting' || userIntent === 'small_talk')) return true;
  if (
    userIntent === 'store_identity_question' ||
    userIntent === 'capability_question' ||
    userIntent === 'general_business_question'
  ) {
    return true;
  }
  return false;
}
