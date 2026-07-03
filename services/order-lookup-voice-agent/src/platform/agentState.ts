/**
 * Unified agent state — single replayable document folded by agentStateReducer.
 *
 * Phase 2: orchestrator reads via projected stores; writes only through dispatch → reducer.
 */
import type { GateIntent } from "../agents/toolDecisionGate.js";
import type {
  CallMemoryMessage,
  SessionProductMemory,
} from "../memory/callMemoryStore.js";
import type {
  CallStateAwaitingInput,
  CallStatePhase,
  CallStateSlotFlags,
  CallStateSlots,
} from "../memory/callStateStore.js";
import type { CallSnapshot } from "./events.js";
import { emptyProductMemory } from "../memory/callMemoryStore.js";

/** Summarized Shopify row held in runtime context (no live API handles). */
export interface RuntimeProductSummary {
  id: string;
  title: string;
  isbns?: string[];
  variantSkus?: string[];
}

export interface AgentRuntimeContext {
  selectedTool?: string;
  toolReason?: string;
  searchKey?: string;
  frozenAt?: number;
  frozenSearchKey?: string;
  explicitRepeat?: boolean;
  /** Active when the fulfillment fast-path handled the prior response. */
  fulfillmentFlow?: boolean;
  lastToolExecution?: {
    tool: string;
    status: string;
    resultCount: number;
    products?: RuntimeProductSummary[];
    orderStatus?: string;
    elapsedMs?: number;
  };
  /** Frozen after VALIDATION_RESULT — catalog gate outcome for this turn. */
  validation?: {
    passed: boolean;
    accepted: number;
    rejected: number;
    reasons?: string[];
    stage?: string;
    frozen: boolean;
  };
}

export interface AgentState {
  callSid: string;
  /** Monotonic user-turn counter mirrored from dispatcher turn_seq. */
  turnSeq: number;
  messages: CallMemoryMessage[];
  recentAssistantPhrases: string[];
  inferredIntent?: string;
  lastIntent?: string;
  lastOrderNumber?: string;
  lastProductId?: string;
  lastProductTitle?: string;
  product: SessionProductMemory;
  phase: CallStatePhase;
  intent: GateIntent;
  slots: CallStateSlots;
  slotFlags: CallStateSlotFlags;
  awaitingInput: CallStateAwaitingInput;
  runtime: AgentRuntimeContext;
  updatedAt: number;
}

const EMPTY_SLOT_FLAGS: CallStateSlotFlags = {
  isbnCollected: false,
  titleCollected: false,
  recommendationsCollected: false,
};

export function createInitialAgentState(callSid: string, now = Date.now()): AgentState {
  return {
    callSid,
    turnSeq: 0,
    messages: [],
    recentAssistantPhrases: [],
    product: emptyProductMemory(),
    phase: "PHASE_1",
    intent: "unknown",
    slots: {},
    slotFlags: { ...EMPTY_SLOT_FLAGS },
    awaitingInput: "none",
    runtime: {},
    updatedAt: now,
  };
}

export function agentStateToCallSnapshot(state: AgentState): CallSnapshot {
  return {
    product: structuredClone(state.product),
    callState: {
      intent: state.intent,
      phase: state.phase,
      awaitingInput: state.awaitingInput,
      slots: structuredClone(state.slots),
      slotFlags: structuredClone(state.slotFlags),
    },
    lastOrderNumber: state.lastOrderNumber,
  };
}
