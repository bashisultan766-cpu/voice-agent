import type { AgentTarget } from "../config.js";
import { getSession } from "./sessionStore.js";
import { classifyIntent, type IntentClassification, type IntentType } from "./intentClassifier.js";
import {
  buildClarifyingResponse,
  buildGreetingResponse,
  buildSilenceReprompt,
} from "./handlers/greetingHandler.js";

export type RouteTarget = AgentTarget | "greeting" | "clarify";

export interface RouteDecision {
  target: RouteTarget;
  intent: IntentType;
  confidence: number;
  reason: string;
  responseText?: string;
}

function isForwardTarget(target: RouteTarget): target is AgentTarget {
  return target === "order_lookup" || target === "main_agent";
}

/**
 * 3-stage pipeline:
 * 1. Intent classification (classifyIntent)
 * 2. Router decision (intent → target)
 * 3. Handler payload (greeting/clarify response text)
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
      intent: targetToIntent(existing.target),
      confidence: 1,
      reason: `session_locked:${existing.reason}`,
    };
  }

  const speech = (input.speech ?? "").trim();

  if (!speech) {
    return {
      target: "clarify",
      intent: "unknown",
      confidence: 0,
      reason: "empty_speech_reprompt",
      responseText: buildSilenceReprompt(),
    };
  }

  const classification = await classifyIntent(speech);
  return routeFromIntent(classification, speech);
}

function routeFromIntent(classification: IntentClassification, speech: string): RouteDecision {
  const base = {
    intent: classification.intent,
    confidence: classification.confidence,
    reason: `intent_${classification.intent}:${classification.source}`,
  };

  switch (classification.intent) {
    case "greeting":
      return {
        ...base,
        target: "greeting",
        responseText: buildGreetingResponse(speech),
      };

    case "order_lookup":
      return {
        ...base,
        target: "order_lookup",
      };

    case "refund":
      return {
        ...base,
        target: "order_lookup",
        reason: `intent_refund:${classification.source}`,
      };

    case "support":
      return {
        ...base,
        target: "main_agent",
        reason: `intent_support:${classification.source}`,
      };

    case "unknown":
    default:
      return {
        ...base,
        target: "clarify",
        responseText: buildClarifyingResponse(),
        reason: `intent_unknown:${classification.source}`,
      };
  }
}

function targetToIntent(target: AgentTarget): IntentType {
  if (target === "order_lookup") return "order_lookup";
  return "support";
}

export { isForwardTarget };
