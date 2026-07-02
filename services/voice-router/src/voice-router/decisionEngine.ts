import type { AgentTarget } from "../config.js";
import { logger } from "../utils/logger.js";
import { isSafeMode } from "../utils/safeMode.js";
import { getSession } from "./sessionStore.js";
import { classifyIntent, type IntentClassification, type IntentType } from "./intentClassifier.js";

export type RouteTarget = AgentTarget | "conversation_brain";

export interface RouteDecision {
  target: RouteTarget;
  intent: IntentType;
  confidence: number;
  reason: string;
}

function isOrderIntent(classification: IntentClassification): boolean {
  return classification.intent === "order_lookup" || classification.intent === "refund";
}

function isProductIntent(classification: IntentClassification): boolean {
  return classification.intent === "product_search" || classification.intent === "isbn_query";
}

export function isForwardTarget(target: RouteTarget): target is AgentTarget {
  return target === "order_lookup";
}

export function safeDefaultRoute(speechText?: string, reason = "safe_default"): RouteDecision {
  void speechText;
  return {
    target: "conversation_brain",
    intent: "unknown",
    confidence: 0,
    reason,
  };
}

function routeFromIntent(classification: IntentClassification): RouteDecision {
  if (!classification?.intent) {
    return safeDefaultRoute(undefined, "missing_intent");
  }

  const base = {
    intent: classification.intent,
    confidence: classification.confidence ?? 0,
  };

  if (isOrderIntent(classification)) {
    return {
      ...base,
      target: "order_lookup",
      reason: `order_intent:${classification.source}`,
    };
  }

  if (isProductIntent(classification)) {
    return {
      ...base,
      target: "order_lookup",
      reason: `product_intent:${classification.source}`,
    };
  }

  return {
    ...base,
    target: "conversation_brain",
    reason: `conversation_brain:${classification.source}`,
  };
}

/**
 * Routing model:
 * - order/refund intent → order-lookup service (order agent)
 * - product/ISBN intent → order-lookup service (product brain agent)
 * - everything else → conversation brain (LLM in router)
 */
export async function decideRoute(input: {
  speech: string;
  callSid: string;
  from?: string;
}): Promise<RouteDecision> {
  const speechText = (input.speech ?? "").trim();

  if (isSafeMode()) {
    console.log("ROUTE:", "conversation_brain (safe_mode)");
    return safeDefaultRoute(speechText, "safe_mode");
  }

  try {
    const existing = getSession(input.callSid);
    if (existing) {
      const decision: RouteDecision = {
        target: existing.target,
        intent: existing.target === "order_lookup" ? "order_lookup" : "unknown",
        confidence: 1,
        reason: `session_locked:${existing.reason}`,
      };
      console.log("ROUTE:", decision.target);
      return decision;
    }

    if (!speechText) {
      const decision = safeDefaultRoute(speechText, "empty_speech_brain");
      console.log("ROUTE:", decision.target);
      return decision;
    }

    const classification = await classifyIntent(speechText);
    const decision = routeFromIntent(classification);
    console.log("ROUTE:", decision.target);
    return decision;
  } catch (error) {
    logger.error("decision_engine_failed", {
      callSid: input.callSid.slice(0, 8),
      error: error instanceof Error ? error.message : String(error),
    });
    console.log("ERROR:", error instanceof Error ? error.stack : String(error));
    const decision = safeDefaultRoute(speechText, "decision_engine_error");
    console.log("ROUTE:", decision.target);
    return decision;
  }
}
