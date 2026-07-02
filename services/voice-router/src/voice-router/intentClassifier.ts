import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";

export type IntentType = "greeting" | "order_lookup" | "refund" | "support" | "unknown";

export interface IntentClassification {
  intent: IntentType;
  confidence: number;
  source: "regex" | "openai" | "default";
}

const ORDER_NUMBER_RE = /\b\d{4,12}\b/;
const ORDER_INTENT_RE =
  /\b(order|tracking|track|status|shipment|shipped|delivery|where\s+is\s+my\s+order|order\s+number|my\s+order)\b/i;
const REFUND_INTENT_RE = /\b(refund|refunded|money\s+back|charge\s+back|return\s+my\s+money)\b/i;
const SUPPORT_INTENT_RE =
  /\b(help|support|speak\s+to\s+someone|representative|agent|customer\s+service|problem|issue|complaint)\b/i;
const GREETING_ONLY_RE =
  /^(hi|hello|hey|howdy|good\s+morning|good\s+afternoon|good\s+evening)(\s+there)?[\s!.?,]*$/i;
const GREETING_PHRASE_RE =
  /\b(how\s+are\s+you|how'?s\s+it\s+going|how\s+are\s+ya|what'?s\s+up|nice\s+to\s+(meet|talk)\s+you|good\s+to\s+hear\s+from\s+you)\b/i;

/**
 * Stage 1 — classify caller speech before any routing or Shopify logic.
 */
export async function classifyIntent(speech: string): Promise<IntentClassification> {
  const text = (speech ?? "").trim();
  if (!text) {
    return { intent: "unknown", confidence: 0, source: "default" };
  }

  const regexResult = classifyWithRegex(text);
  if (regexResult) return regexResult;

  const llmResult = await classifyWithOpenAi(text);
  if (llmResult) return llmResult;

  return { intent: "unknown", confidence: 0.35, source: "default" };
}

function classifyWithRegex(text: string): IntentClassification | null {
  if (REFUND_INTENT_RE.test(text)) {
    return { intent: "refund", confidence: 0.9, source: "regex" };
  }

  if (ORDER_NUMBER_RE.test(text) || ORDER_INTENT_RE.test(text)) {
    return { intent: "order_lookup", confidence: 0.95, source: "regex" };
  }

  if (GREETING_ONLY_RE.test(text) || GREETING_PHRASE_RE.test(text)) {
    return { intent: "greeting", confidence: 0.95, source: "regex" };
  }

  if (SUPPORT_INTENT_RE.test(text)) {
    return { intent: "support", confidence: 0.85, source: "regex" };
  }

  return null;
}

async function classifyWithOpenAi(speech: string): Promise<IntentClassification | null> {
  const apiKey = getConfig().OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const client = new OpenAI({
      apiKey,
      timeout: getConfig().OPENAI_TIMEOUT_MS,
    });

    const response = await client.chat.completions.create({
      model: getConfig().OPENAI_MODEL,
      temperature: 0,
      max_tokens: 60,
      messages: [
        {
          role: "system",
          content: `Classify SureShot Books phone caller intent. Return JSON only:
{"intent":"greeting"|"order_lookup"|"refund"|"support"|"unknown","confidence":0.0-1.0}

Rules:
- greeting: hi, hello, how are you, small talk — NOT an order attempt
- order_lookup: order status, tracking, order numbers, "where is my order"
- refund: refunds, money back, charge disputes on an order
- support: general help, complaints, speak to someone (non-order-specific)
- unknown: unclear intent

Never classify casual greetings as order_lookup.`,
        },
        { role: "user", content: speech },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { intent?: string; confidence?: number };
    const intent = normalizeIntent(parsed.intent);
    if (!intent) return null;

    const confidence =
      typeof parsed.confidence === "number"
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.7;

    return { intent, confidence, source: "openai" };
  } catch (err) {
    logger.warn("intent_classification_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function normalizeIntent(value?: string): IntentType | null {
  const intents: IntentType[] = ["greeting", "order_lookup", "refund", "support", "unknown"];
  return intents.includes(value as IntentType) ? (value as IntentType) : null;
}
