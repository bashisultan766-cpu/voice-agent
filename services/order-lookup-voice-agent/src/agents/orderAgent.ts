import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  extractOrderNumberFromSpeech,
  GREETING_PROMPT,
  ORDER_NOT_FOUND_MESSAGE,
  SHOPIFY_DOWN_MESSAGE,
  GOODBYE_MESSAGE,
} from "../utils/formatter.js";
import { sanitizeForSpeech } from "../utils/security.js";
import { lookupOrder } from "../services/shopifyService.js";
import {
  extractOrderNumberWithLlm,
  classifyFollowUpIntent,
  preAnalyzeOrderIntent,
} from "../services/llmService.js";
import {
  planInstantConfirmation,
  planInstantFiller,
  planLookupError,
  planOrderLookupResponse,
  planGoodbye,
  planRepeatIntro,
} from "./responsePlanner.js";
import { classifyCallerIntent } from "./intentClassifier.js";
import { generateConversationResponse } from "./conversationBrainAgent.js";
import type {
  AgentStreamEvent,
  CallSession,
  OrderLookupResult,
  SpeechChunk,
  StructuredOrder,
} from "../types/order.js";

export interface AgentTurnResult {
  speech: string;
  endCall?: boolean;
  phase: CallSession["phase"];
}

export function createCallSession(callSid: string, from: string, to: string): CallSession {
  return {
    callSid,
    from,
    to,
    phase: "greeting",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
  };
}

/** Streaming-first turn handler — yields speech chunks as they are ready. */
export async function* streamAgentTurn(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  const text = sanitizeForSpeech((callerText ?? "").trim());

  switch (session.phase) {
    case "greeting":
    case "awaiting_order_number":
      yield* streamOrderNumberCapture(session, text);
      return;

    case "order_disclosed":
    case "follow_up":
      yield* streamFollowUp(session, text);
      return;

    default:
      yield chunkEvent(GREETING_PROMPT, "closing");
      session.phase = "awaiting_order_number";
      yield doneEvent(session.phase);
  }
}

/** Collect full turn for tests and legacy callers. */
export async function handleAgentTurn(
  session: CallSession,
  callerText: string,
): Promise<AgentTurnResult> {
  const parts: string[] = [];
  let phase = session.phase;
  let endCall = false;

  for await (const event of streamAgentTurn(session, callerText)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
    if (event.type === "done") {
      phase = event.phase;
      endCall = event.endCall ?? false;
    }
  }

  return { speech: parts.join(" "), phase, endCall };
}

async function* streamOrderNumberCapture(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  const intent = await classifyCallerIntent(callerText);

  const regexOrder = extractOrderNumberFromSpeech(callerText);
  let orderNumber: string | null = regexOrder;

  if (!orderNumber) {
    orderNumber = await extractOrderNumberWithLlm(callerText);
  }

  const hasOrderIntent =
    intent.intent === "order_lookup" || intent.intent === "refund" || Boolean(orderNumber);

  if (!orderNumber || !hasOrderIntent) {
    session.phase = "awaiting_order_number";
    const brainResponse = await generateConversationResponse({
      callSid: session.callSid,
      userMessage: callerText,
      inferredIntent: intent.intent,
      situationalHint:
        hasOrderIntent && !orderNumber
          ? "Caller seems to want order help but no clear order number yet — guide them gently."
          : undefined,
    });
    yield chunkEvent(brainResponse, "summary");
    yield doneEvent(session.phase);
    return;
  }

  session.phase = "lookup_in_progress";
  const started = Date.now();

  yield chunkEvent(planInstantFiller());

  const lookupPromise = lookupOrder(orderNumber);
  void preAnalyzeOrderIntent(orderNumber);

  const lookup = await lookupPromise;
  const lookupMs = Date.now() - started;

  logger.info("order_lookup_complete", {
    callSid: session.callSid.slice(0, 8),
    orderNumber,
    status: lookup.status,
    lookupMs,
    firstChunkMs: lookupMs,
  });

  if (lookup.status === "found") {
    yield chunkEvent(planInstantConfirmation(lookup.order));
    for (const chunk of planOrderLookupResponse(lookup.order).chunks) {
      yield { type: "chunk", chunk };
    }
    session.currentOrder = lookup.order;
    session.phase = "order_disclosed";
    yield doneEvent(session.phase, false, lookupMs);
    return;
  }

  const errorMeta = yield* streamLookupError(session, lookup);
  yield doneEvent(session.phase, errorMeta.endCall, lookupMs);
}

async function* streamLookupError(
  session: CallSession,
  lookup: OrderLookupResult,
): AsyncGenerator<AgentStreamEvent, { endCall: boolean }> {
  const plan = planLookupError(lookup);
  for (const chunk of plan.chunks) {
    yield { type: "chunk", chunk };
  }

  if (lookup.status === "invalid_format" || lookup.status === "not_found") {
    session.orderNumberAttempts += 1;
    session.phase = "awaiting_order_number";
    if (session.orderNumberAttempts >= getConfig().ORDER_LOOKUP_MAX_RETRIES) {
      yield chunkEvent(GOODBYE_MESSAGE, "closing");
      session.phase = "ended";
      return { endCall: true };
    }
    return { endCall: false };
  }

  if (lookup.status === "api_error") {
    session.phase = "awaiting_order_number";
  }

  return { endCall: false };
}

async function* streamFollowUp(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  const intent = await classifyFollowUpIntent(callerText);

  if (intent === "goodbye") {
    session.phase = "ended";
    yield chunkEvent(planGoodbye());
    yield doneEvent(session.phase, true);
    return;
  }

  if (intent === "repeat_order" && session.currentOrder) {
    yield chunkEvent(planRepeatIntro());
    yield* streamOrderSummary(session.currentOrder);
    session.phase = "follow_up";
    yield doneEvent(session.phase);
    return;
  }

  session.phase = "follow_up";
  const brainResponse = await generateConversationResponse({
    callSid: session.callSid,
    userMessage: callerText,
    inferredIntent: "follow_up",
  });
  yield chunkEvent(brainResponse, "closing");
  yield doneEvent(session.phase);
}

async function* streamOrderSummary(order: StructuredOrder): AsyncGenerator<AgentStreamEvent> {
  yield chunkEvent(planInstantConfirmation(order));
  for (const chunk of planOrderLookupResponse(order).chunks) {
    yield { type: "chunk", chunk };
  }
}

function chunkEvent(chunk: SpeechChunk | string, kind?: SpeechChunk["kind"]): AgentStreamEvent {
  if (typeof chunk === "string") {
    return { type: "chunk", chunk: { text: chunk, kind: kind ?? "summary" } };
  }
  return { type: "chunk", chunk };
}

function doneEvent(
  phase: CallSession["phase"],
  endCall = false,
  lookupMs?: number,
): AgentStreamEvent {
  return { type: "done", phase, endCall, lookupMs };
}

export async function getInitialGreeting(session: CallSession): Promise<string> {
  session.phase = "awaiting_order_number";
  return GREETING_PROMPT;
}

// Re-export stable error strings for tests.
export { ORDER_NOT_FOUND_MESSAGE, SHOPIFY_DOWN_MESSAGE };
