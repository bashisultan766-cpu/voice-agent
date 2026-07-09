import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { extractIsbnFromSpeech } from "../tools/shopifyProductTools.js";
import {
  getConversationFlowMode,
  isConfirmKeyword,
  isIntentAllowedInCurrentFlow,
  transitionFlowForIntent,
  type ConversationFlowMode,
} from "./conversationFlowState.js";

export type CallerIntent =
  | "greeting"
  | "order_lookup"
  | "refund"
  | "support"
  | "product_search"
  | "isbn_query"
  | "unknown";

export interface IntentClassification {
  intent: CallerIntent;
  confidence: number;
  source: "regex" | "openai" | "default";
  flowMode?: ConversationFlowMode;
}

export interface ClassifyCallerIntentOptions {
  callSid?: string;
  inPurchaseFlow?: boolean;
}

export async function classifyCallerIntent(
  speech: string,
  options: ClassifyCallerIntentOptions = {},
): Promise<IntentClassification> {
  const text = (speech ?? "").trim();
  if (!text) {
    return { intent: "unknown", confidence: 0, source: "default" };
  }

  const callSid = options.callSid ?? "";
  const flowMode = callSid ? getConversationFlowMode(callSid) : "idle";
  const purchaseFlow = options.inPurchaseFlow ?? flowMode === "PURCHASE_FLOW";

  if (purchaseFlow && isConfirmKeyword(text)) {
    return {
      intent: "product_search",
      confidence: 0.92,
      source: "regex",
      flowMode: "PURCHASE_FLOW",
    };
  }

  const regexResult = classifyWithRegex(text, callSid);
  if (regexResult) {
    if (callSid) transitionFlowForIntent(callSid, regexResult.intent);
    return { ...regexResult, flowMode: callSid ? getConversationFlowMode(callSid) : undefined };
  }

  const llmResult = await classifyWithOpenAi(text, callSid);
  if (llmResult) {
    if (callSid) transitionFlowForIntent(callSid, llmResult.intent);
    return { ...llmResult, flowMode: callSid ? getConversationFlowMode(callSid) : undefined };
  }

  return {
    intent: "unknown",
    confidence: 0.35,
    source: "default",
    flowMode: callSid ? getConversationFlowMode(callSid) : undefined,
  };
}

const ISBN_IN_SPEECH = /\b(isbn|97[89][\d-]{10,17}|[\d-]{9,}[\dXx])\b/i;
const PRODUCT_SEARCH_RE =
  /\b(book|books|magazine|magazines|newspaper|newspapers|title|author|do you (have|sell|carry)|looking for|i want .+ book|harry potter|similar to|like this|catalog|browse)\b/i;
const ORDER_NUMBER_RE = /\b\d{4,12}\b/;
const ORDER_INTENT_RE =
  /\b(order|tracking|track|status|shipment|shipped|delivery|where\s+is\s+my\s+order|order\s+number|my\s+order)\b/i;
const REFUND_INTENT_RE = /\b(refund|refunded|money\s+back|charge\s+back)\b/i;
const GREETING_ONLY_RE =
  /^(hi|hello|hey|howdy|good\s+morning|good\s+afternoon|good\s+evening)(\s+there)?[\s!.?,]*$/i;
const GREETING_PHRASE_RE =
  /\b(how\s+are\s+you|how'?s\s+it\s+going|how\s+are\s+ya|what'?s\s+up|nice\s+to\s+(meet|talk)\s+you)\b/i;

function classifyWithRegex(text: string, callSid = ""): IntentClassification | null {
  if (extractIsbnFromSpeech(text) || ISBN_IN_SPEECH.test(text)) {
    if (callSid && !isIntentAllowedInCurrentFlow(callSid, "isbn_query")) {
      return null;
    }
    return { intent: "isbn_query", confidence: 0.95, source: "regex" };
  }

  if (PRODUCT_SEARCH_RE.test(text) && !ORDER_INTENT_RE.test(text)) {
    if (callSid && !isIntentAllowedInCurrentFlow(callSid, "product_search")) {
      return null;
    }
    return { intent: "product_search", confidence: 0.9, source: "regex" };
  }

  if (ORDER_NUMBER_RE.test(text) || ORDER_INTENT_RE.test(text)) {
    if (callSid && !isIntentAllowedInCurrentFlow(callSid, "order_lookup")) {
      return null;
    }
    return { intent: "order_lookup", confidence: 0.95, source: "regex" };
  }

  if (REFUND_INTENT_RE.test(text)) {
    if (callSid && !isIntentAllowedInCurrentFlow(callSid, "order_lookup")) {
      return null;
    }
    return { intent: "order_lookup", confidence: 0.9, source: "regex" };
  }

  if (GREETING_ONLY_RE.test(text) || GREETING_PHRASE_RE.test(text)) {
    return { intent: "greeting", confidence: 0.95, source: "regex" };
  }

  return null;
}

async function classifyWithOpenAi(speech: string, callSid = ""): Promise<IntentClassification | null> {
  try {
    const client = new OpenAI({
      apiKey: getConfig().OPENAI_API_KEY,
      timeout: getConfig().OPENAI_TIMEOUT_MS,
    });

    const response = await client.chat.completions.create({
      model: getConfig().OPENAI_MODEL,
      temperature: 0,
      max_tokens: 60,
      messages: [
        {
          role: "system",
          content: `Classify SureShot Books bookstore phone intent. JSON only:
{"intent":"greeting"|"order_lookup"|"refund"|"support"|"product_search"|"isbn_query"|"unknown","confidence":0.0-1.0}

product_search = book titles, magazines, newspapers, catalog browsing
isbn_query = ISBN numbers in speech (classification only — never triggers tools)
order_lookup = order status/tracking/order numbers
greeting = hi, how are you

Classify intent only. Never call Shopify or search tools.`,
        },
        { role: "user", content: speech },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { intent?: string; confidence?: number };
    const intents: CallerIntent[] = [
      "greeting",
      "order_lookup",
      "refund",
      "support",
      "product_search",
      "isbn_query",
      "unknown",
    ];
    if (!parsed.intent || !intents.includes(parsed.intent as CallerIntent)) return null;

    if (callSid && !isIntentAllowedInCurrentFlow(callSid, parsed.intent)) {
      return null;
    }

    return {
      intent: parsed.intent as CallerIntent,
      confidence:
        typeof parsed.confidence === "number"
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0.7,
      source: "openai",
    };
  } catch (err) {
    logger.warn("caller_intent_classification_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
