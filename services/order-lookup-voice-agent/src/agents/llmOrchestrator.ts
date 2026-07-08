/**
 * LLM-first orchestrator turn — replaces rigid fulfillment awaiting-slot loops.
 */
import type { CallSession, AgentStreamEvent } from "../types/order.js";
import { dispatchAgentEvent, getAgentState } from "../platform/eventDispatcher.js";
import {
  runLlmAgentTurnEvents,
  syncDeterministicAssistantSpeech,
} from "../adapters/openaiAdapter.js";
import type { LlmToolExecutionRecord } from "../adapters/llmToolExecutor.js";
import type { LlmAgentTurnResult } from "../adapters/openaiAdapter.js";
import { orderStatusToStructuredOrder } from "./fulfillmentHandlers.js";
import {
  buildActiveOrderContextFromResult,
  clearActiveOrderContext,
  saveActiveOrderContext,
} from "./sessionManager.js";
import { applyCallerVerificationFromOrder } from "./callerVerification.js";
import { planInstantFiller } from "./responsePlanner.js";
import { speechChunksFromText } from "../services/voiceSmoothingEngine.js";
import { isTrackingDictationText, sanitizeTextForTTS } from "../utils/ttsFormatter.js";
import { getOrCreateCallState } from "../memory/callStateStore.js";
import { syncSessionFromCallState } from "../memory/callStateSessionSync.js";
import { logFinalResponseType } from "../runtime/turnObservability.js";
import type { FinalResponseType } from "../runtime/turnObservability.js";
import type { GateIntent } from "./toolDecisionGate.js";
import { clearCallerMemory } from "../utils/callerMemory.js";
import { clearLastSpokenSentence } from "../services/llmService.js";
import {
  getOrCreateActiveSession,
  recordToolPayload,
  recordTrackingPayload,
} from "../sovereign/activeSession.js";
import { promptUserForNotepad, completeTrackingDictation, TRACKING_DICTATION_COMPLETE_SPEECH } from "./dictationTool.js";
import { isTrackingDictationCompleteIntent } from "./trackingIntent.js";

export { LLM_ORCHESTRATOR_TEMPERATURE } from "./llmConfig.js";

function mapToolToGateIntent(tool: LlmToolExecutionRecord["tool"]): GateIntent {
  if (tool === "get_shopify_order_status") return "order";
  return "product";
}

function chunkEvent(text: string, preserveFull = false): AgentStreamEvent {
  return {
    type: "chunk",
    chunk: { text, kind: "summary", pauseMs: 0, preserveFull },
  };
}

function doneEvent(phase: CallSession["phase"], endCall = false): AgentStreamEvent {
  return { type: "done", phase, endCall };
}

function* yieldSpeech(text: string, preserveFull = false): Generator<AgentStreamEvent> {
  const sanitized = sanitizeTextForTTS(text);
  const isDictation = isTrackingDictationText(sanitized);
  const kind = isDictation ? ("dictation" as const) : ("summary" as const);
  for (const chunk of speechChunksFromText(sanitized, kind, { preserveFull: preserveFull || isDictation })) {
    yield { type: "chunk", chunk };
  }
}

function applySessionPhaseAfterTurn(
  session: CallSession,
  responseType: FinalResponseType,
): void {
  switch (responseType) {
    case "order_found":
      session.phase = "order_disclosed";
      session.awaitingInput = null;
      break;
    case "order_not_found":
    case "order_api_error":
      session.phase = "awaiting_order_number";
      session.awaitingInput = "order_number";
      break;
    case "confirmed_product":
      session.phase = "follow_up";
      session.awaitingInput = null;
      break;
    default:
      session.awaitingInput = null;
      break;
  }
}

function persistOrderContext(
  session: CallSession,
  result: LlmAgentTurnResult,
): void {
  const orderExec = [...result.toolExecutions]
    .reverse()
    .find((exec) => exec.tool === "get_shopify_order_status");

  if (!orderExec) return;

  const orderData =
    orderExec.tool === "get_shopify_order_status" ? orderExec.data : undefined;

  if (!orderExec.ok || !orderData || !("status" in orderData) || orderData.status !== "found") {
    clearActiveOrderContext(session);
    session.isVerifiedCaller = false;
    return;
  }

  if ("orderNumber" in orderData) {
    applyCallerVerificationFromOrder(session, orderData);
  }

  const payload = buildActiveOrderContextFromResult(orderData, session);
  if (payload) {
    saveActiveOrderContext(session, payload);
    const trackingRaw = String(payload.tracking_number ?? "").trim();
    const active = getOrCreateActiveSession(session.callSid);
    if (trackingRaw && !active.lastSpokenPayload?.trackingForTts) {
      recordTrackingPayload(session.callSid, trackingRaw);
    }
  }

  if (!("orderNumber" in orderData)) return;

  const structured = orderStatusToStructuredOrder(orderData);
  if (structured) {
    session.currentOrder = structured;
  }
}

export async function* runLlmOrchestratorTurn(
  session: CallSession,
  text: string,
  _emitResponse: (
    callSid: string,
    responseType: FinalResponseType,
    speech: string,
    meta?: Record<string, unknown>,
  ) => void,
): AsyncGenerator<AgentStreamEvent> {
  const agentState = getAgentState(session.callSid);

  let result: LlmAgentTurnResult | undefined;

  for await (const event of runLlmAgentTurnEvents({
    callSid: session.callSid,
    userMessage: text,
    session,
    messages: agentState.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    activeOrderContext: session.currentOrderData,
  })) {
      if (event.type === "tool_pending") {
        yield { type: "chunk", chunk: planInstantFiller(event.tools[0]) };
        continue;
      }
    result = event.result;
  }

  if (!result) {
    yield doneEvent(session.phase);
    return;
  }

  const lastTool = result.toolExecutions[result.toolExecutions.length - 1];
  const gateIntent: GateIntent = lastTool ? mapToolToGateIntent(lastTool.tool) : "unknown";

  dispatchAgentEvent(session.callSid, {
    type: "MEMORY_SYNCD",
    payload: {
      mergeInput: {
        intent: gateIntent,
        incomingSlots: {
          isbn: lastTool?.args.isbn,
          title: lastTool?.args.title,
        },
        userMessage: text,
      },
      memoryCommitTimestamp: Date.now(),
    },
  });

  if (lastTool) {
    dispatchAgentEvent(session.callSid, {
      type: "TOOL_SELECTED",
      payload: {
        tool: lastTool.tool,
        reason: "llm_tool_call",
        validationReady: true,
        intent: gateIntent,
        flow: lastTool.tool === "get_shopify_order_status" ? "ORDER_FLOW" : "PRODUCT_FLOW",
        gateDecision: lastTool.tool,
      },
    });
  }

  for (const exec of result.toolExecutions) {
    dispatchAgentEvent(session.callSid, {
      type: "TOOL_EXECUTION_STARTED",
      payload: { tool: exec.tool },
    });

    dispatchAgentEvent(session.callSid, {
      type: "TOOL_EXECUTION_COMPLETED",
      payload: {
        tool: exec.tool,
        status: exec.ok ? "found" : exec.status === "blocked" ? "not_found" : "error",
        resultCount: exec.ok ? 1 : 0,
        elapsedMs: exec.elapsedMs,
        products:
          exec.data && "bookName" in exec.data && exec.data.bookName
            ? [{ id: exec.data.productId ?? "unknown", title: exec.data.bookName }]
            : undefined,
      },
    });
  }

  const preserveFullSpeech =
    result.responseType === "order_found" ||
    result.toolExecutions.some((exec) => exec.tool === "dictate_tracking" && exec.ok);
  let speech = result.speech.trim();
  const activeSession = getOrCreateActiveSession(session.callSid);
  if (
    isTrackingDictationCompleteIntent(text) &&
    Boolean(activeSession.lastSpokenPayload?.trackingForTts) &&
    (activeSession.currentState === "tracking_dictation" || activeSession.cachedIntent === "tracking")
  ) {
    completeTrackingDictation(session.callSid);
    speech = TRACKING_DICTATION_COMPLETE_SPEECH;
    session.phase = "follow_up";
  } else if (
    !activeSession.isNotepadReady &&
    activeSession.lastSpokenPayload?.trackingForTts &&
    isTrackingDictationText(speech)
  ) {
    speech = promptUserForNotepad();
  }
  const finalizeToolExecution = result.toolExecutions.some((t) => t.ok);

  syncDeterministicAssistantSpeech(session.callSid, speech, {
    responseType: result.responseType,
    recordOrderNumber: result.recordOrderNumber,
    recordProduct: result.recordProduct,
    finalizeToolExecution,
  });

  logFinalResponseType(session.callSid, result.responseType, {
    fulfillmentFlow: true,
    finalizeToolExecution,
    recordOrderNumber: result.recordOrderNumber,
    recordProduct: result.recordProduct,
  });

  applySessionPhaseAfterTurn(session, result.responseType);
  persistOrderContext(session, result);

  const orderExec = result.toolExecutions.find((exec) => exec.tool === "get_shopify_order_status" && exec.ok);
  if (orderExec?.data && "trackingNumber" in orderExec.data && orderExec.data.trackingNumber) {
    const active = getOrCreateActiveSession(session.callSid);
    if (!active.lastSpokenPayload?.trackingForTts) {
      recordTrackingPayload(session.callSid, String(orderExec.data.trackingNumber), result.speech);
    }
  } else if (orderExec?.ok) {
    recordToolPayload(session.callSid, {
      kind: "order_status",
      speech: result.speech,
      toolName: "get_shopify_order_status",
      intentKey: "order",
      state: "order_active",
    });
  } else {
    const catalogExec = result.toolExecutions.find(
      (exec) =>
        (exec.tool === "search_shopify_book_by_title" ||
          exec.tool === "search_shopify_book_by_isbn") &&
        exec.ok,
    );
    if (catalogExec) {
      recordToolPayload(session.callSid, {
        kind: "catalog",
        speech: result.speech,
        toolName: catalogExec.tool,
        intentKey: "catalog",
        state: "catalog_active",
      });
    }
  }

  if (result.endCall) {
    session.phase = "ended";
    clearCallerMemory(session.callerPhone ?? session.from);
    clearLastSpokenSentence(session.callSid);
  }

  yield* yieldSpeech(speech, preserveFullSpeech);
  syncSessionFromCallState(session, getOrCreateCallState(session.callSid));
  yield doneEvent(session.phase, result.endCall ?? false);
}
