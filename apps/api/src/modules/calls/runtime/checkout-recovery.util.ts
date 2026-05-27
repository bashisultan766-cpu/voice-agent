import type { CallConversationMemory } from '@bookstore-voice-agents/types';
import type { OrderState } from './order-state-machine.util';
import { classifyConversationalObjection } from './objection-patterns.util';

export type CheckoutAbandonReason =
  | 'call_later'
  | 'let_me_think'
  | 'too_expensive'
  | 'changed_mind'
  | 'email_hesitation'
  | 'unknown';

export function detectCheckoutAbandonReason(
  userText: string,
  orderState: OrderState,
): CheckoutAbandonReason | null {
  if (orderState !== 'EMAIL_COLLECTION') {
    const objection = classifyConversationalObjection(userText);
    if (objection?.type === 'call_later' || objection?.type === 'let_me_think') {
      return objection.type === 'call_later' ? 'call_later' : 'let_me_think';
    }
    return null;
  }
  const t = userText.toLowerCase();
  if (/\b(call later|call back|not now|later)\b/.test(t)) return 'call_later';
  if (/\b(think about|let me think|not sure yet)\b/.test(t)) return 'let_me_think';
  if (/\b(too expensive|cheaper|can't afford)\b/.test(t)) return 'too_expensive';
  if (/\b(different book|wrong book|never mind|cancel)\b/.test(t)) return 'changed_mind';
  if (/\b(not ready|don't want email|no email)\b/.test(t)) return 'email_hesitation';
  return null;
}

export function buildCheckoutRecoveryGuidance(
  reason: CheckoutAbandonReason,
  memory: CallConversationMemory,
): string {
  const cartTitle = memory.cart?.items?.[memory.cart.items.length - 1]?.title;
  switch (reason) {
    case 'call_later':
      return 'Checkout recovery: offer secure email checkout link or callback — keep tone warm, no pressure.';
    case 'let_me_think':
      return 'Checkout recovery: validate their pause; offer to hold cart title or send link when ready.';
    case 'too_expensive':
      return 'Checkout recovery: search one lower-priced in-stock alternative; cite tool price only.';
    case 'changed_mind':
      return 'Checkout recovery: return to discovery — ask what title to search instead.';
    case 'email_hesitation':
      return 'Checkout recovery: explain email is only for Shopify payment link; offer human follow-up if needed.';
    default:
      return cartTitle
        ? `Checkout recovery: gently confirm if they still want "${cartTitle}" or prefer another search.`
        : 'Checkout recovery: one clarifying question before closing the call.';
  }
}

export function checkoutRecoveryReplySeed(
  reason: CheckoutAbandonReason,
  memory: CallConversationMemory,
): string | null {
  const title = memory.cart?.items?.[memory.cart.items.length - 1]?.title;
  switch (reason) {
    case 'call_later':
      return 'Absolutely — I can email a secure checkout link so you can finish when ready. What email works?';
    case 'let_me_think':
      return title
        ? `No rush on "${title}". I can send a payment link when you're ready — would that help?`
        : 'Take your time. I can send a checkout link when you are ready.';
    case 'too_expensive':
      return 'I can search for a lower-priced option in stock. What genre should I try?';
    case 'changed_mind':
      return 'Sure — what title should I look up instead?';
    case 'email_hesitation':
      return 'The email is only used to send the official Shopify payment link — nothing else. Want to use a different address?';
    default:
      return null;
  }
}
