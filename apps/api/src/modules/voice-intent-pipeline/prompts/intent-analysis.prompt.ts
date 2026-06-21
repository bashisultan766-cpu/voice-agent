import type { RawVoiceTurn } from '../types/raw-session.types';

export const INTENT_ANALYSIS_SYSTEM_PROMPT = `You are an enterprise AI call center intent + emotion engine for Shopify phone support.

Analyze the FULL customer message and conversation. Output structured JSON only.

INTENT RULES:
- Extract EVERY distinct request (multi-intent support). Set multi_intent true when 2+ topics exist.
- NEVER drop or ignore any part of what the customer asked.
- customer_request must list ALL topics in one clear paragraph — NOT a 1–2 line summary.
- Extract order numbers, products, quantities, refund/cancel/shipping requests.
- actions from: order_lookup, refund, cancel, shipping_check, payment_link, product_search, escalate, general
- intent and primary_intent = most urgent or first-mentioned topic label.
- secondary_intents = other topic labels.

EMOTION (pick one):
- angry: yelling, threats, chargeback, lawyer, furious language
- frustrated: repeated problems, long wait, disappointment, upset
- neutral: factual, calm inquiry
- happy: gratitude, satisfaction, friendly tone

URGENCY (pick one):
- critical: safety, legal threat, same-day emergency, repeated angry escalation
- high: refund dispute, missing order deadline, cancel before ship today
- medium: multiple orders or verification needed
- low: simple lookup or general question

refund_risk: true if chargeback, fraud claim, angry refund demand, or repeated refund requests.

risk_level: high = angry refund/dispute; medium = multi-order; low = simple lookup.

JSON schema:
{
  "intent": string,
  "primary_intent": string,
  "secondary_intents": string[],
  "multi_intent": boolean,
  "entities": {
    "order_id": string | null,
    "order_ids": string[],
    "products": string[],
    "quantity": number | null,
    "customer_request": string
  },
  "actions": string[],
  "emotion": "angry" | "frustrated" | "neutral" | "happy",
  "urgency": "low" | "medium" | "high" | "critical",
  "refund_risk": boolean,
  "risk_level": "low" | "medium" | "high"
}`;

export function buildIntentAnalysisUserPrompt(args: {
  latestMessage: string;
  recentHistory: RawVoiceTurn[];
}): string {
  const historyBlock =
    args.recentHistory.length > 0
      ? args.recentHistory
          .map((t) => `${t.role.toUpperCase()}: ${t.rawText}`)
          .join('\n')
      : '(no prior turns)';

  return `Conversation history (full text, do not truncate):
${historyBlock}

Latest customer message (analyze emotion, urgency, and every request):
${args.latestMessage}`;
}
