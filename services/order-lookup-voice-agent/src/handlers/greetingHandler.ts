const HOW_ARE_YOU_RE = /\bhow\s+are\s+you\b/i;

/** Short follow-up only — Twilio welcomeGreeting already introduced the assistant. */
export function buildGreetingResponse(speech?: string): string {
  const text = (speech ?? "").trim();

  if (HOW_ARE_YOU_RE.test(text)) {
    return "I'm doing well, thanks for asking. What can I help you with today?";
  }

  return "Sure — what can I help you with? Order status, a book search, or something else?";
}

export function buildClarifyingResponse(): string {
  return "What's your order number? It's usually four to six digits.";
}
