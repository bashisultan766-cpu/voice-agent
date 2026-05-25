import type { OrderState } from './order-state-machine.util';
import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { OrderTurnIntent } from './order-intent-classifier.util';

export type ConversationTone = 'direct' | 'friendly' | 'neutral';

type ToneLeadSlot =
  | 'product_found'
  | 'correction'
  | 'email'
  | 'price'
  | 'email_ack'
  | 'objection'
  | 'none';

const LEAD_YES = 'Yes,';
const LEAD_GOT_IT = 'Got it,';
const LEAD_SURE = 'Sure,';
const LEAD_ALRIGHT = 'Alright,';
const LEAD_ABSOLUTELY = 'Absolutely,';
const LEAD_PERFECT = 'Perfect,';
const LEAD_OKAY = 'Okay,';

/**
 * Session tone: short utterances → direct; warm markers → friendly; else neutral.
 */
export function detectConversationTone(text: string): ConversationTone {
  const t = text.trim();
  const lower = t.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);

  if (
    /\b(thanks|thank you|thx|please|appreciate|appreciated|wonderful|lovely|great to|nice to)\b/i.test(lower) ||
    /\b(how are you|hope you|have a good)\b/i.test(lower)
  ) {
    return 'friendly';
  }

  if (words.length <= 3 && t.length <= 24 && !t.includes('?')) {
    return 'direct';
  }

  return 'neutral';
}

/**
 * Rule-based leads; never use the same lead as the previous turn.
 */
export function resolveToneLead(args: {
  slot: ToneLeadSlot;
  conversationTone: ConversationTone;
  lastToneLeadUsed: string | null | undefined;
}): { lead: string; toneLeadUsed: string | null } {
  const last = (args.lastToneLeadUsed ?? '').trim();
  const pick = (candidates: string[]): { lead: string; toneLeadUsed: string | null } => {
    const filtered = candidates.filter((x) => x !== last);
    const choice = (filtered[0] ?? candidates[0] ?? '').trim();
    return choice ? { lead: choice, toneLeadUsed: choice } : { lead: '', toneLeadUsed: null };
  };

  if (args.slot === 'none') {
    return { lead: '', toneLeadUsed: null };
  }

  if (args.slot === 'product_found') {
    if (args.conversationTone === 'friendly') {
      return pick([LEAD_YES, LEAD_ABSOLUTELY, LEAD_PERFECT]);
    }
    return pick([LEAD_YES, LEAD_ALRIGHT]);
  }

  if (args.slot === 'correction') {
    return pick([LEAD_GOT_IT, LEAD_OKAY, LEAD_ALRIGHT]);
  }

  if (args.slot === 'email') {
    return pick([LEAD_SURE, LEAD_PERFECT, LEAD_ALRIGHT]);
  }

  if (args.slot === 'email_ack') {
    return pick([LEAD_GOT_IT, LEAD_PERFECT, LEAD_OKAY]);
  }

  if (args.slot === 'price') {
    if (args.conversationTone === 'direct') {
      return { lead: '', toneLeadUsed: null };
    }
    return pick([LEAD_ALRIGHT, LEAD_OKAY]);
  }

  if (args.slot === 'objection') {
    return pick([LEAD_SURE, LEAD_GOT_IT, LEAD_ALRIGHT]);
  }

  return { lead: '', toneLeadUsed: null };
}

/**
 * Only offer the explicit payment-link line after buy intent or order progression — not while browsing or for vague input.
 */
export function computeAllowPaymentSuggestion(args: {
  userIntent: UserUtteranceIntent;
  clsIntent: OrderTurnIntent;
  orderState: OrderState;
}): boolean {
  if (args.userIntent === 'purchase_confirmation') return true;
  if (args.orderState === 'EMAIL_COLLECTION') return true;
  if (args.clsIntent === 'product_confirmed' || args.clsIntent === 'order_confirmed') return true;
  return false;
}

export function responseIncludesPaymentSuggestion(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('checkout link') || t.includes('payment link');
}
