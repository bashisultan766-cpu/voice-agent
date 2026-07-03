/**
 * LLM-first orchestrator turn — replaces rigid fulfillment awaiting-slot loops.
 */
import type { CallSession, AgentStreamEvent } from "../types/order.js";
import { dispatchAgentEvent, getAgentState } from "../platform/eventDispatcher.js";
import { runLlmAgentTurnEvents } from "../adapters/openaiAdapter.js";
import type { LlmToolExecutionRecord } from "../adapters/llmToolExecutor.js";
import type { LlmAgentTurnResult } from "../adapters/openaiAdapter.js";
import { planInstantFiller } from "./responsePlanner.js";
import { smoothForVoice } from "../services/voiceSmoothingEngine.js";
import { getOrCreateCallState } from "../memory/callStateStore.js";
import { syncSessionFromCallState } from "../memory/callStateSessionSync.js";
import type { FinalResponseType } from "../runtime/turnObservability.js";
import type { GateIntent } from "./toolDecisionGate.js";

function mapToolToGateIntent(tool: LlmToolExecutionRecord["tool"]): GateIntent {
  if (tool === "get_shopify_order_status") return "order";
  return "product";
}

function chunkEvent(text: string): AgentStreamEvent {
  return { type: "chunk", chunk: { text, kind: "summary", pauseMs: 0 } };
}

function doneEvent(phase: CallSession["phase"]): AgentStreamEvent {
  return { type: "done", phase };
}

function* yieldSpeech(text: string): Generator<AgentStreamEvent> {
  for (const sentence of text.split(/(?<=[.!?])\s+/).filter(Boolean)) {
    yield chunkEvent(sentence);
  }
}

export async function* runLlmOrchestratorTurn(
  session: CallSession,
  text: string,
  emitResponse: (
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
    messages: agentState.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  })) {
    if (event.type === "tool_pending") {
      yield { type: "chunk", chunk: planInstantFiller() };
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

  const speech = smoothForVoice(result.speech);

  if (result.responseType === "order_found") {
    session.phase = "order_disclosed";
    session.awaitingInput = null;
  } else {
    session.phase = "awaiting_order_number";
    session.awaitingInput = null;
  }

  emitResponse(session.callSid, result.responseType, speech, {
    fulfillmentFlow: true,
    finalizeToolExecution: result.toolExecutions.some((t) => t.ok),
    recordOrderNumber: result.recordOrderNumber,
    recordProduct: result.recordProduct,
  });

  yield* yieldSpeech(speech);
  syncSessionFromCallState(session, getOrCreateCallState(session.callSid));
  yield doneEvent(session.phase);
}
