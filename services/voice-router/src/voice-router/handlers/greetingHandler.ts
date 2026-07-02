const HOW_ARE_YOU_RE = /\bhow\s+are\s+you\b/i;
const HELLO_RE = /^(hi|hello|hey)\b/i;

/**
 * Stage 3 — warm conversational replies with no downstream agent or Shopify calls.
 */
export function buildGreetingResponse(speech?: string): string {
  const text = (speech ?? "").trim();

  if (HOW_ARE_YOU_RE.test(text)) {
    return "Hey! I'm doing well — thanks for asking. How can I help you today?";
  }

  if (HELLO_RE.test(text)) {
    return "Hey! I'm here to help you with your order or anything else. What can I do for you?";
  }

  return "Hi there! How can I help you today?";
}

export function buildClarifyingResponse(): string {
  return "I can help you track an order or answer questions about SureShot Books. What's your order number, or how can I help?";
}

export function buildSilenceReprompt(): string {
  return "I didn't hear anything. You can tell me your order number, or just say how I can help.";
}
