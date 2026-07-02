const HOW_ARE_YOU_RE = /\bhow\s+are\s+you\b/i;
const HELLO_RE = /^(hi|hello|hey)\b/i;

export function buildGreetingResponse(speech?: string): string {
  const text = (speech ?? "").trim();

  if (HOW_ARE_YOU_RE.test(text)) {
    return "Hey! I'm doing well — thanks for asking. Whenever you're ready, just give me your order number.";
  }

  if (HELLO_RE.test(text)) {
    return "Hey! I'm here to help with your order. What's your order number?";
  }

  return "Hi there! I can look up your order — just share your order number when you're ready.";
}

export function buildClarifyingResponse(): string {
  return "I can help you check an order status. What's your order number? It's usually four to six digits.";
}
