/**
 * Pure agent state machine — (previousState, event) => newState
 *
 * INVARIANTS:
 * - No I/O, no DB, no network, no store mutation
 * - Deterministic: same inputs always yield same outputs
 * - Replay-safe: offline timeline reconstruction via replayEngine
 */
import type { AgentEvent } from "./events.js";
import type { AgentState } from "./agentState.js";
import {
  applyDecisionToCallStatePure,
  applyProductMemoryToCallState,
  finalizeAfterToolExecution,
  pureCommitMemoryTurn,
  pureSelfHealResync,
} from "./mergeLogic.js";

const MAX_MESSAGES = 10;
const MAX_RECENT_PHRASES = 6;

function trimMessages(messages: AgentState["messages"]): AgentState["messages"] {
  if (messages.length <= MAX_MESSAGES) return messages;
  return messages.slice(-MAX_MESSAGES);
}

function appendUserMessage(state: AgentState, content: string, now: number): AgentState {
  const messages = trimMessages([
    ...state.messages,
    { role: "user", content, timestamp: now },
  ]);
  return { ...state, messages, updatedAt: now };
}

function appendAssistantMessage(state: AgentState, content: string, now: number): AgentState {
  const trimmed = content.trim();
  const messages = trimMessages([
    ...state.messages,
    { role: "assistant", content: trimmed, timestamp: now },
  ]);
  const recentAssistantPhrases = [trimmed, ...state.recentAssistantPhrases].slice(
    0,
    MAX_RECENT_PHRASES,
  );
  return { ...state, messages, recentAssistantPhrases, updatedAt: now };
}

/**
 * Core reducer — folds one validated AgentEvent into AgentState.
 */
export function agentStateReducer(state: AgentState, event: AgentEvent, now = Date.now()): AgentState {
  switch (event.type) {
    case "TURN_INGESTED": {
      const nextTurn = state.turnSeq + 1;
      let next = { ...state, turnSeq: nextTurn, updatedAt: now };
      if (event.payload.userMessage?.trim()) {
        next = appendUserMessage(next, event.payload.userMessage.trim(), now);
      }
      return next;
    }

    case "MEMORY_SYNCD": {
      if (event.payload.selfHealResync) {
        const healed = pureSelfHealResync(state, now);
        const callState = applyProductMemoryToCallState(
          {
            callSid: state.callSid,
            phase: state.phase,
            intent: state.intent,
            slots: state.slots,
            slotFlags: state.slotFlags,
            awaitingInput: state.awaitingInput,
            updatedAt: now,
          },
          healed.productMemory,
        );
        return {
          ...state,
          ...healed.callStateSlice,
          product: healed.productMemory,
          slots: callState.slots,
          slotFlags: callState.slotFlags,
          updatedAt: now,
        };
      }

      if (!event.payload.mergeInput) {
        return { ...state, updatedAt: now };
      }

      const merged = pureCommitMemoryTurn(state, {
        intent: event.payload.mergeInput.intent,
        incomingSlots: event.payload.mergeInput.incomingSlots ?? {},
        userMessage: event.payload.mergeInput.userMessage,
      }, now);
      return {
        ...state,
        ...merged.callStateSlice,
        product: merged.productMemory,
        inferredIntent: merged.callStateSlice.intent,
        updatedAt: now,
      };
    }

    case "TOOL_SELECTED": {
      let next: AgentState = {
        ...state,
        runtime: {
          ...state.runtime,
          selectedTool: event.payload.tool,
          toolReason: event.payload.reason,
          searchKey: event.payload.searchKey,
        },
        inferredIntent: event.payload.intent,
        updatedAt: now,
      };

      if (event.payload.gateDecision) {
        const callState = applyDecisionToCallStatePure(
          {
            callSid: state.callSid,
            phase: state.phase,
            intent: state.intent,
            slots: state.slots,
            slotFlags: state.slotFlags,
            awaitingInput: state.awaitingInput,
            updatedAt: now,
          },
          event.payload.gateDecision,
        );
        next = {
          ...next,
          phase: callState.phase,
          awaitingInput: callState.awaitingInput,
        };
      }

      return next;
    }

    case "EXECUTION_FROZEN":
      return {
        ...state,
        runtime: {
          ...state.runtime,
          frozenAt: event.payload.frozenAt,
          frozenSearchKey: event.payload.searchKey,
          explicitRepeat: event.payload.explicitRepeat,
        },
        updatedAt: now,
      };

    case "TOOL_EXECUTION_STARTED":
      return {
        ...state,
        phase: "PHASE_2",
        runtime: {
          ...state.runtime,
          lastToolExecution: {
            tool: event.payload.tool,
            status: "started",
            resultCount: 0,
          },
        },
        updatedAt: now,
      };

    case "TOOL_EXECUTION_COMPLETED": {
      const next: AgentState = {
        ...state,
        runtime: {
          ...state.runtime,
          lastToolExecution: {
            tool: event.payload.tool,
            status: event.payload.status,
            resultCount: event.payload.resultCount,
            products: event.payload.products,
            orderStatus: event.payload.orderStatus,
            elapsedMs: event.payload.elapsedMs,
          },
        },
        updatedAt: now,
      };

      if (event.payload.tool === "searchOrderById" && event.payload.status === "found") {
        return next;
      }

      return next;
    }

    case "VALIDATION_RESULT": {
      const next: AgentState = {
        ...state,
        runtime: {
          ...state.runtime,
          validation: {
            passed: event.payload.passed,
            accepted: event.payload.accepted,
            rejected: event.payload.rejected,
            reasons: event.payload.reasons,
            stage: event.payload.stage,
            frozen: true,
          },
        },
        updatedAt: now,
      };

      if (
        event.payload.passed &&
        event.payload.accepted === 1 &&
        state.runtime.lastToolExecution?.products?.[0]
      ) {
        const product = state.runtime.lastToolExecution.products[0];
        const searchKey =
          state.runtime.frozenSearchKey ?? state.runtime.searchKey ?? state.product.lastSearchKey;
        return {
          ...next,
          product: {
            ...state.product,
            lastResultProductId: product.id,
            lastSearchKey: searchKey,
          },
          lastProductId: product.id,
          lastProductTitle: product.title,
        };
      }

      return next;
    }

    case "RESPONSE_SENT": {
      let next = { ...state, updatedAt: now };

      if (event.payload.speech?.trim()) {
        next = appendAssistantMessage(next, event.payload.speech, now);
      }

      if (event.payload.recordOrderNumber) {
        next = { ...next, lastOrderNumber: event.payload.recordOrderNumber };
      }

      if (event.payload.recordProduct) {
        const { id, title, searchKey } = event.payload.recordProduct;
        next = {
          ...next,
          product: {
            ...next.product,
            lastResultProductId: id,
            lastSearchKey: searchKey ?? next.product.lastSearchKey,
          },
          lastProductId: id,
          lastProductTitle: title,
        };
      }

      if (event.payload.responseType === "general_help") {
        next = { ...next, lastIntent: "general_help" };
      }

      if (event.payload.finalizeToolExecution) {
        const finalized = finalizeAfterToolExecution({
          callSid: state.callSid,
          phase: state.phase,
          intent: state.intent,
          slots: state.slots,
          slotFlags: state.slotFlags,
          awaitingInput: state.awaitingInput,
          updatedAt: now,
        });
        next = {
          ...next,
          phase: finalized.phase,
          slotFlags: finalized.slotFlags,
          awaitingInput: finalized.awaitingInput,
        };
      }

      return next;
    }

    default:
      return state;
  }
}
