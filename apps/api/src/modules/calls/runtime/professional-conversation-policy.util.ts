import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { OrderState } from './order-state-machine.util';
import { EMAIL_SPELL_COLLECTION_PROMPT } from './voice-email-capture.util';
import {
  BOOK_NEED_PROMPT,
  QUANTITY_PROMPT,
  SURESHOT_INBOUND_GREETING,
  isGenericBookNeedUtterance,
  sanitizeBookstoreVoicePhrases,
} from './book-sales-voice.util';

/** High-level route used before tools / OpenAI for phone-sales behavior. */
export type ConversationRouteIntent =
  | 'GREETING'
  | 'SMALL_TALK'
  | 'PRODUCT_SEARCH'
  | 'PRODUCT_SELECTED'
  | 'ORDER_STATUS'
  | 'REFUND_POLICY'
  | 'SHIPPING_POLICY'
  | 'FACILITY_RULES'
  | 'CHECKOUT'
  | 'HUMAN_HANDOFF'
  | 'UNKNOWN_BUSINESS_RELATED'
  | 'OUT_OF_SCOPE'
  | 'WHO_ARE_YOU'
  | 'HEAR_ME'
  | 'BOOK_NEED'
  | 'UNCLEAR';

export type ProfessionalConversationContext = {
  customerText: string;
  userIntent: UserUtteranceIntent;
  orderState: OrderState;
  storeName?: string | null;
  agentName?: string | null;
  selectedProductTitle?: string | null;
  /** When true, caller already discussed a title this call. */
  hasDiscussedProduct?: boolean;
};

const DEFAULT_STORE = 'SureShot Books';
const DEFAULT_AGENT = 'Justin';

const BANNED_PHRASE_PATTERNS: RegExp[] = [
  /\bgo ahead\b/gi,
  /\bthank you for asking\.?\s*$/i,
  /\bjust a moment[,.\s]+let me check\b/gi,
  /\bi am an ai assistant\b/gi,
  /\bi'?m an ai\b/gi,
  /\bdesigned to assist\b/gi,
];

export function sanitizeBannedVoicePhrases(text: string): string {
  let t = text.trim();
  if (!t) return t;
  for (const re of BANNED_PHRASE_PATTERNS) {
    t = t.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }
  if (/^thank you for asking\.?$/i.test(t)) {
    return '';
  }
  return sanitizeBookstoreVoicePhrases(t);
}

function norm(text: string): string {
  return text.toLowerCase().trim();
}

function displayStore(ctx: ProfessionalConversationContext): string {
  const s = ctx.storeName?.trim();
  return s && s.length > 0 ? s : DEFAULT_STORE;
}

function displayAgent(ctx: ProfessionalConversationContext): string {
  const a = ctx.agentName?.trim();
  return a && a.length > 0 ? a : DEFAULT_AGENT;
}

export function classifyConversationRouteIntent(ctx: ProfessionalConversationContext): ConversationRouteIntent {
  const t = norm(ctx.customerText);
  if (!t) return 'UNCLEAR';

  if (/\b(can you hear me|do you hear me|are you there|can you hear)\b/.test(t)) {
    return 'HEAR_ME';
  }

  if (
    ctx.userIntent === 'store_identity_question' ||
    /\b(who are you|what('?s| is) your name|who am i speaking with)\b/.test(t)
  ) {
    return 'WHO_ARE_YOU';
  }

  if (ctx.userIntent === 'greeting') return 'GREETING';

  if (isGenericBookNeedUtterance(ctx.customerText)) return 'BOOK_NEED';

  if (ctx.userIntent === 'small_talk') return 'SMALL_TALK';

  if (
    ctx.userIntent === 'purchase_confirmation' ||
    /\b(i want (the )?(first|second|third|this|that) one|i'?ll take|ill take|order that|add it|yes that book|this one|that one|the first one)\b/.test(
      t,
    )
  ) {
    if (
      ctx.hasDiscussedProduct ||
      ctx.selectedProductTitle ||
      ctx.orderState === 'PRODUCT_CONFIRMED' ||
      ctx.orderState === 'PRODUCT_SEARCH' ||
      ctx.orderState === 'QUANTITY_COLLECTED'
    ) {
      return 'PRODUCT_SELECTED';
    }
  }

  if (ctx.orderState === 'EMAIL_COLLECTING' || ctx.orderState === 'EMAIL_CONFIRMING') {
    return 'CHECKOUT';
  }

  if (ctx.userIntent === 'store_policy_question') {
    if (/\b(refund|return|exchange)\b/.test(t)) return 'REFUND_POLICY';
    if (/\b(shipp|deliver|mail)\b/.test(t)) return 'SHIPPING_POLICY';
    if (/\b(facility|prison|jail|institution|transfer)\b/.test(t)) return 'FACILITY_RULES';
    return 'UNKNOWN_BUSINESS_RELATED';
  }

  if (/\b(order status|where is my order|track(ing)? (my )?order|shipment)\b/.test(t)) {
    return 'ORDER_STATUS';
  }

  if (/\b(speak to (a )?human|real person|manager|representative|agent|callback)\b/.test(t)) {
    return 'HUMAN_HANDOFF';
  }

  if (
    ctx.userIntent === 'store_category_question' ||
    /\b(weather|politics|football|crypto|medical|legal advice)\b/.test(t)
  ) {
    return 'OUT_OF_SCOPE';
  }

  if (ctx.userIntent === 'product_search' || ctx.userIntent === 'product_question') {
    return 'PRODUCT_SEARCH';
  }

  if (
    ctx.userIntent === 'capability_question' ||
    ctx.userIntent === 'general_business_question' ||
    ctx.userIntent === 'payment_question'
  ) {
    return 'UNKNOWN_BUSINESS_RELATED';
  }

  if (ctx.userIntent === 'unclear' || ctx.userIntent === 'unknown') {
    return 'UNCLEAR';
  }

  return 'UNKNOWN_BUSINESS_RELATED';
}

/** Intents that must not trigger product/order tools on this turn. */
export function conversationRouteBlocksTools(route: ConversationRouteIntent): boolean {
  return (
    route === 'GREETING' ||
    route === 'BOOK_NEED' ||
    route === 'SMALL_TALK' ||
    route === 'WHO_ARE_YOU' ||
    route === 'HEAR_ME' ||
    route === 'OUT_OF_SCOPE' ||
    route === 'UNCLEAR' ||
    route === 'UNKNOWN_BUSINESS_RELATED' ||
    route === 'HUMAN_HANDOFF'
  );
}

export function shouldUseProfessionalFastReply(
  route: ConversationRouteIntent,
  toolCallAllowed: boolean,
): boolean {
  if (conversationRouteBlocksTools(route)) return true;
  if (route === 'PRODUCT_SELECTED') return true;
  if (route === 'PRODUCT_SEARCH' && !toolCallAllowed) return true;
  if (route === 'CHECKOUT' && !toolCallAllowed) return true;
  return false;
}

/**
 * Deterministic professional replies — no tools, no robotic fillers.
 * Returns null when OpenAI/tools should handle the turn.
 */
export function buildProfessionalConversationReply(
  route: ConversationRouteIntent,
  ctx: ProfessionalConversationContext,
): string | null {
  const store = displayStore(ctx);
  const agent = displayAgent(ctx);
  const title = ctx.selectedProductTitle?.trim();

  switch (route) {
    case 'GREETING':
      return SURESHOT_INBOUND_GREETING;
    case 'BOOK_NEED':
      return BOOK_NEED_PROMPT;
    case 'SMALL_TALK':
      if (/\bhow\s+(are|r)\s+(you|u|ya)\b/.test(norm(ctx.customerText))) {
        return `I'm doing well, thank you. How can I help you with your book order today?`;
      }
      if (/\b(thanks|thank you)\b/.test(norm(ctx.customerText))) {
        return `You're welcome. What else can I help you with today?`;
      }
      return `I'm doing well, thank you. How can I help you with your book order today?`;
    case 'WHO_ARE_YOU':
      return `I'm ${agent} with ${store}. I can help you find books, check an order, or place a new order.`;
    case 'HEAR_ME':
      return `Yes, I can hear you clearly. How can I help?`;
    case 'PRODUCT_SEARCH':
      return `Absolutely. What book title or author are you looking for?`;
    case 'PRODUCT_SELECTED':
      if (title) {
        return `Perfect. I've selected ${title} for you. ${EMAIL_SPELL_COLLECTION_PROMPT}`;
      }
      return `Perfect. ${EMAIL_SPELL_COLLECTION_PROMPT}`;
    case 'CHECKOUT':
      return EMAIL_SPELL_COLLECTION_PROMPT;
    case 'ORDER_STATUS':
      return `I can help with that. Do you have your order number, or the email you used when you ordered?`;
    case 'REFUND_POLICY':
    case 'SHIPPING_POLICY':
    case 'FACILITY_RULES':
      return null;
    case 'HUMAN_HANDOFF':
      return `I can connect you with our team. May I have your name and the best number to reach you?`;
    case 'OUT_OF_SCOPE':
      return `I'm here to help with ${store} orders, books, shipping, and store policies. What can I help you with today?`;
    case 'UNCLEAR':
      return `I want to make sure I help correctly. Are you looking for a book, checking an order, or asking about shipping?`;
    case 'UNKNOWN_BUSINESS_RELATED':
      if (ctx.userIntent === 'capability_question' || ctx.userIntent === 'general_business_question') {
        return `I can help you find books, check availability and pricing, and email a secure payment link. What would you like to do today?`;
      }
      return `I want to make sure I help correctly. Are you looking for a book, checking an order, or asking about shipping?`;
    default:
      return null;
  }
}

export const PROFESSIONAL_CONVERSATION_POLICY_PROMPT = `Professional phone conversation policy (mandatory):
- You are Justin, a professional phone sales representative for SureShot Books Publishing LLC.
- The call flow greets first, then: book need → title/category → Shopify search → title + price + stock → quantity → email → payment link.
- Speak warmly, calmly, and confidently. Keep replies to 1–2 short sentences. One question at a time.
- Never say: "go ahead", "dropshipping", "drop shipping", "just a moment let me check" (unless a tool is running), "thank you for asking" alone, or "I am an AI assistant".
- Greetings and small talk: respond naturally without calling product or order tools.
- Generic "I need a book" → ask title, author, or category (history, romance, religion, fiction).
- Product search: use searchProducts; always state title, price, and stock when Shopify returns them; ask if they want to order.
- Multiple books in one sentence: search each title separately.
- When the customer agrees to order, ask quantity, then say: "Perfect. I'll help you place the order. Please tell me your email address so I can send your payment link."
- Read email back for confirmation before any payment link. Never claim a payment link was sent unless the email send API succeeded.
- Never invent products, prices, or policies — use Shopify tools only when needed.`;
