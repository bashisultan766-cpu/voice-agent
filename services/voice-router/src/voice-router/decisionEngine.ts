import OpenAI from "openai";
import { getConfig, type AgentTarget } from "../config.js";
import { logger } from "../utils/logger.js";
import { getSession } from "./sessionStore.js";

export interface RouteDecision {
  target: AgentTarget;
  reason: string;
  confidence: "high" | "medium" | "low";
}

const ORDER_NUMBER_RE = /\b\d{5,12}\b/;
const ORDER_INTENT_RE =
  /\b(order|tracking|track|status|shipment|shipped|delivery|refund|where\s+is\s+my\s+order|order\s+number)\b/i;

export async function decideRoute(input: {
  speech: string;
  callSid: string;
  from?: string;
}): Promise<RouteDecision> {
  const existing = getSession(input.callSid);
  if (existing) {
    return {
      target: existing.target,
      reason: `session_locked:${existing.reason}`,
      confidence: "high",
    };
  }

  const speech = (input.speech ?? "").trim();
  if (!speech) {
    return {
      target: "main_agent",
      reason: "empty_speech_default_main",
      confidence: "low",
    };
  }

  if (ORDER_NUMBER_RE.test(speech)) {
    return {
      target: "order_lookup",
      reason: "order_number_pattern",
      confidence: "high",
    };
  }

  if (ORDER_INTENT_RE.test(speech)) {
    return {
      target: "order_lookup",
      reason: "order_intent_keywords",
      confidence: "high",
    };
  }

  const llmDecision = await classifyWithOpenAi(speech);
  if (llmDecision) {
    return llmDecision;
  }

  return {
    target: "main_agent",
    reason: "general_intent_default",
    confidence: "medium",
  };
}

async function classifyWithOpenAi(speech: string): Promise<RouteDecision | null> {
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
      max_tokens: 40,
      messages: [
        {
          role: "system",
          content:
            'Classify caller intent for SureShot Books phone support. Return JSON only: {"intent":"order_lookup"|"general","confidence":"high"|"medium"|"low"}. Use order_lookup for order status, tracking, refunds, or order numbers. Use general for catalog, buying books, facilities, or other questions.',
        },
        { role: "user", content: speech },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      intent?: string;
      confidence?: "high" | "medium" | "low";
    };

    if (parsed.intent === "order_lookup") {
      return {
        target: "order_lookup",
        reason: "openai_order_lookup",
        confidence: parsed.confidence ?? "medium",
      };
    }

    if (parsed.intent === "general") {
      return {
        target: "main_agent",
        reason: "openai_general",
        confidence: parsed.confidence ?? "medium",
      };
    }
  } catch (err) {
    logger.warn("openai_route_classification_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return null;
}
