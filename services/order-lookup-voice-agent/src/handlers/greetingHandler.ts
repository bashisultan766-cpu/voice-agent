const HOW_ARE_YOU_RE = /\bhow\s+are\s+you\b/i;

const SOCIAL_GREETING_RE =
  /^(hi|hello|hey|howdy|good\s+(morning|afternoon|evening))[\s!.?,]*$/i;

/** True for hello / how-are-you style turns that should not trigger order collection. */
export function isSocialGreetingUtterance(speech?: string): boolean {
  const text = (speech ?? "").trim();
  if (!text) return false;
  if (SOCIAL_GREETING_RE.test(text)) return true;
  if (/^(hi|hello|hey)\b/i.test(text) && HOW_ARE_YOU_RE.test(text)) return true;
  if (HOW_ARE_YOU_RE.test(text)) return true;
  if (/\bhow'?s\s+it\s+going\b/i.test(text)) return true;
  if (/\b(good\s+morning|good\s+afternoon|good\s+evening)\b/i.test(text)) return true;
  return false;
}

/** Caller says they have an order number but has not spoken the digits yet. */
export function isOrderNumberOfferUtterance(speech?: string): boolean {
  const text = (speech ?? "").trim();
  if (!text) return false;
  if (/\b\d{4,10}\b/.test(text)) return false;
  return /\b(?:i\s+have\s+(?:an?\s+|my\s+|the\s+)?order(?:\s+number)?|have\s+(?:an?\s+|my\s+)?order\s+number|my\s+order\s+number\s+is|want\s+to\s+(?:check|look\s*up)\s+(?:my\s+)?order|check\s+(?:my\s+)?order|order\s+status)\b/i.test(
    text,
  );
}

/** Short follow-up only — Twilio welcomeGreeting already introduced the assistant. */
export function buildGreetingResponse(speech?: string): string {
  const text = (speech ?? "").trim();

  if (HOW_ARE_YOU_RE.test(text)) {
    return "I'm doing great, thanks for asking! How can I help you today — checking an order, finding a book, or something else?";
  }

  if (SOCIAL_GREETING_RE.test(text)) {
    return "Hi there! I'm doing well. What can I help you with — order status, a book search, or something else?";
  }

  return "Sure — what can I help you with? Order status, a book search, or something else?";
}

export function buildOrderNumberOfferResponse(): string {
  return "Perfect — go ahead and tell me your order number whenever you're ready.";
}

const AWAITING_ORDER_CLARIFIERS = [
  "What's your order number? It's usually four to six digits.",
  "Whenever you're ready, say your order number — four to six digits.",
  "Go ahead with your order number when you have it — usually four to six digits.",
];

export function buildClarifyingResponse(turnIndex = 0): string {
  return AWAITING_ORDER_CLARIFIERS[turnIndex % AWAITING_ORDER_CLARIFIERS.length];
}
