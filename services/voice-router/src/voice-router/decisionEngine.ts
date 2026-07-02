import type { AgentTarget } from "../config.js";
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
  return (
    classification.intent === "order_lookup" ||
    classification.intent === "refund"
  );
}

export function isForwardTarget(target: RouteTarget): target is AgentTarget {
  return target === "order_lookup";
}

/**
 * Routing model:
 * - order intent → order-lookup service (8002)
 * - everything else → conversation brain (LLM)
 */
export async function decideRoute(input: {
  speech: string;
  callSid: string;
  from?: string;
}): Promise<RouteDecision> {
  const existing = getSession(input.callSid);
  if (existing) {
    return {
      target: existing.target,
      intent: existing.target === "order_lookup" ? "order_lookup" : "support",
      confidence: 1,
      reason: `session_locked:${existing.reason}`,
    };
  }

  const speech = (input.speech ?? "").trim();
  if (!speech) {
    return {
      target: "conversation_brain",
      intent: "unknown",
      confidence: 0,
      reason: "empty_speech_brain",
    };
  }

  const classification = await classifyIntent(speech);
  return routeFromIntent(classification);
}

function routeFromIntent(classification: IntentClassification): RouteDecision {
  const base = {
    intent: classification.intent,
    confidence: classification.confidence,
  };

  if (isOrderIntent(classification)) {
    return {
      ...base,
      target: "order_lookup",
      reason: `order_intent:${classification.source}`,
    };
  }

  return {
    ...base,
    target: "conversation_brain",
    reason: `conversation_brain:${classification.source}`,
  };
}
