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
import {
  clearActiveOrderContext,
  getActiveOrderContext,
  saveActiveOrderContext,
} from "./sessionManager.js";
import {
  hasConfirmedOrderContext,
  saveSessionOrderContext,
} from "./orderContextPolicy.js";
import { planInstantFiller } from "./responsePlanner.js";
import { speechChunksFromText } from "../services/voiceSmoothingEngine.js";
import { isTrackingDictationText, sanitizeTextForTTS } from "../utils/ttsFormatter.js";
import { getOrCreateCallState } from "../memory/callStateStore.js";
import { syncSessionFromCallState } from "../memory/callStateSessionSync.js";
import { logFinalResponseType } from "../runtime/turnObservability.js";
import type { FinalResponseType } from "../runtime/turnObservability.js";
import type { GateIntent } from "./toolGateTypes.js";
import { clearCallerMemory } from "../utils/callerMemory.js";
import { clearLastSpokenSentence } from "../services/llmService.js";
import {
  getOrCreateActiveSession,
  recordToolPayload,
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
    case "clarification_question":
      // Keep explicit slot awaits set by intercepts (e.g. order_number offer).
      if (!session.awaitingInput) {
        session.awaitingInput = null;
      }
      break;
    default:
      // Do not wipe an active order_number slot mid-conversation.
      if (session.awaitingInput !== "order_number") {
        session.awaitingInput = null;
      }
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

  if (
    !orderExec.ok ||
    !orderData ||
    !("status" in orderData) ||
    orderData.status !== "found"
  ) {
    clearActiveOrderContext(session);
    session.isVerifiedCaller = false;
    return;
  }

  // get_shopify_order_status now returns CallerOrderLookupResult — a
  // disclosure-safe view. Any raw OrderStatusResult would fail the
  // sessionSerialization invariant on next persist.
  if ("orderView" in orderData && orderData.orderView) {
    const view = orderData.orderView;
    session.isVerifiedCaller =
      "is_verified_caller" in orderData ? orderData.is_verified_caller === true : session.isVerifiedCaller === true;
    const orderNumber = String(view.order_number ?? "");
    if (orderNumber) {
      saveSessionOrderContext(session, {
        orderNumber,
        orderView: view,
        verified: session.isVerifiedCaller === true,
      });
      const active: Record<string, unknown> = {
        order_number: view.order_number ?? "",
        customer_name: view.customer_name,
        fulfillment_status: view.fulfillment_status,
        financial_status: view.financial_status,
        items: view.items,
        subtotal_amount: view.totals?.subtotal,
        total_tax: view.totals?.tax,
        shipping_amount: view.totals?.shipping,
        total_amount: view.totals?.total,
        shipping_fee: view.shipping_fee ?? view.totals?.shipping,
        subtotal_price: view.subtotal_price ?? view.totals?.subtotal,
        payment_method: view.payment_method ?? null,
        order_metafields: view.order_metafields ?? null,
        timeline_attachments: view.timeline_attachments ?? [],
        tracking_available: view.tracking_available,
        tracking_number: view.tracking_number,
        tracking_number_for_tts: view.tracking_number_for_tts,
        refund_notification_email: view.refund_notification_email,
        is_verified_caller: session.isVerifiedCaller === true,
      };
      if (session.isVerifiedCaller === true) {
        active.shipping_address = view.shipping_address;
        active.past_order_history = view.past_order_history;
      }
      saveActiveOrderContext(session, active);
      recordToolPayload(session.callSid, {
        kind: "order_status",
        speech: "",
        toolName: "get_shopify_order_status",
        intentKey: "order",
        state: "order_active",
      });
    }
    return;
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
  let streamedSpeech = false;

  for await (const event of runLlmAgentTurnEvents({
    callSid: session.callSid,
    userMessage: text,
    session,
    messages: agentState.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    activeOrderContext: hasConfirmedOrderContext(session)
      ? (getActiveOrderContext(session) as import("./sessionManager.js").ActiveOrderContextData)
      : undefined,
  })) {
      if (event.type === "tool_pending") {
        // Speak filler BEFORE Shopify/tool awaits resume in the adapter generator.
        const heavy =
          event.tools.find((t) =>
            t === "search_shopify_book_by_title" ||
            t === "search_shopify_book_by_isbn" ||
            t === "get_shopify_order_status" ||
            t === "get_customer_history" ||
            t === "send_checkout_email" ||
            t === "update_cart_item_quantity",
        ) ?? event.tools[0];
        yield { type: "chunk", chunk: planInstantFiller(heavy) };
        continue;
      }
      if (event.type === "speech_delta") {
        streamedSpeech = true;
        yield* yieldSpeech(event.text);
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
  const rawResultSpeech = result.speech.trim();
  let speech = rawResultSpeech;
  const activeSession = getOrCreateActiveSession(session.callSid);
  const trackingDictationContext = {
    currentState: activeSession.currentState,
    lastSpokenIndex: activeSession.lastSpokenIndex,
  };
  if (
    isTrackingDictationCompleteIntent(text, trackingDictationContext) &&
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

  for (const exec of result.toolExecutions) {
    if (exec.tool !== "verify_caller_challenge" || !exec.ok) continue;
    if (session.isVerifiedCaller !== true) continue;
    const prior = getActiveOrderContext(session);
    if (prior) {
      saveActiveOrderContext(session, {
        ...prior,
        is_verified_caller: true,
      });
    }
    if (session.sessionOrderContext) {
      session.sessionOrderContext = {
        ...session.sessionOrderContext,
        verificationLevel: "verified",
        orderView: {
          ...session.sessionOrderContext.orderView,
          verificationLevel: "verified",
          shipping_address:
            (prior?.shipping_address as string | undefined) ??
            session.sessionOrderContext.orderView.shipping_address,
          past_order_history:
            prior?.past_order_history ??
            session.sessionOrderContext.orderView.past_order_history,
        },
      };
    }
  }

  applySessionPhaseAfterTurn(session, result.responseType);
  persistOrderContext(session, result);

  const orderExec = result.toolExecutions.find((exec) => exec.tool === "get_shopify_order_status" && exec.ok);
  if (orderExec?.ok) {
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

  // Token streaming already spoke sentence chunks; only speak full speech when not streamed.
  // If orchestrator overrode speech after stream (notepad / tracking complete), speak the override.
  if (!streamedSpeech || speech !== rawResultSpeech) {
    yield* yieldSpeech(speech, preserveFullSpeech);
  }
  syncSessionFromCallState(session, getOrCreateCallState(session.callSid));
  yield doneEvent(session.phase, result.endCall ?? false);
}
