/**
 * Per-call state machine — single source of truth for slots, phase, and intent.
 */
import type { GateIntent } from "../agents/toolDecisionGate.js";
import { isTitleReadyForSearch } from "../agents/productSlotPhase.js";
import type { ProductSearchSlots } from "../types/order.js";

export type CallStatePhase = "PHASE_1" | "PHASE_2";
export type CallStateIntent = GateIntent;
export type CallStateAwaitingInput =
  | "none"
  | "isbn"
  | "title"
  | "isbn_or_title"
  | "order_number";

export interface CallStateSlots {
  isbn?: string;
  title?: string;
  wantsRecommendations?: boolean;
}

export interface CallState {
  callSid: string;
  phase: CallStatePhase;
  intent: CallStateIntent;
  slots: CallStateSlots;
  awaitingInput: CallStateAwaitingInput;
  updatedAt: number;
}

const TTL_MS = 60 * 60 * 1000;
const states = new Map<string, CallState>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [sid, state] of states.entries()) {
    if (now - state.updatedAt > TTL_MS) {
      states.delete(sid);
    }
  }
}

export function createInitialCallState(callSid: string): CallState {
  return {
    callSid,
    phase: "PHASE_1",
    intent: "unknown",
    slots: {},
    awaitingInput: "none",
    updatedAt: Date.now(),
  };
}

export function getOrCreateCallState(callSid: string): CallState {
  purgeExpired();
  const existing = states.get(callSid);
  if (existing) return existing;

  const state = createInitialCallState(callSid);
  states.set(callSid, state);
  return state;
}

export function saveCallState(state: CallState): void {
  state.updatedAt = Date.now();
  states.set(state.callSid, state);
}

export interface ProductSlotValidation {
  ready: boolean;
  reason?: "missing_slots" | "title_needs_confirmation" | "recommendations_needs_confirmation";
}

export interface AtomicTurnResult {
  state: CallState;
  wasAwaiting: CallStateAwaitingInput;
  slotsCollected: boolean;
  validation: ProductSlotValidation;
}

/**
 * Validates product slots before any Shopify tool may run.
 * ISBN may proceed immediately; title/recommendations require prior slot collection.
 */
export function validateProductSlotState(
  state: CallState,
  slotsCollected: boolean,
): ProductSlotValidation {
  if (state.intent !== "product") {
    return { ready: true };
  }

  const hasIsbn = Boolean(state.slots.isbn);
  const hasTitle = Boolean(state.slots.title);
  const wantsRec = Boolean(state.slots.wantsRecommendations);

  if (!hasIsbn && !hasTitle && !wantsRec) {
    return { ready: false, reason: "missing_slots" };
  }

  if (hasIsbn) {
    return { ready: true };
  }

  if (hasTitle && !isTitleReadyForSearch(state.slots.title, slotsCollected)) {
    return { ready: false, reason: "title_needs_confirmation" };
  }

  if (wantsRec && !slotsCollected) {
    return { ready: false, reason: "recommendations_needs_confirmation" };
  }

  return { ready: true };
}

export function isProductToolAction(decision: string): boolean {
  return (
    decision === "searchProductByISBN" ||
    decision === "searchProductByTitle" ||
    decision === "getSimilarProducts"
  );
}

/**
 * Atomic turn update: read → merge → validate → persist. No partial writes.
 */
export function atomicMergeTurnState(
  callSid: string,
  input: {
    intent: GateIntent;
    incomingSlots: ProductSearchSlots;
  },
): AtomicTurnResult {
  const previous = getOrCreateCallState(callSid);
  const wasAwaiting = previous.awaitingInput;
  const merged = mergeTurnIntoCallState(previous, input);
  const slotsCollected = isSlotAnswerComplete(wasAwaiting, merged.slots);
  const validation = validateProductSlotState(merged, slotsCollected);

  saveCallState(merged);

  return {
    state: getOrCreateCallState(callSid),
    wasAwaiting,
    slotsCollected,
    validation,
  };
}

export function mergeTurnIntoCallState(
  state: CallState,
  input: {
    intent: GateIntent;
    incomingSlots: ProductSearchSlots;
  },
): CallState {
  const slots: CallStateSlots = {
    isbn: input.incomingSlots.isbn ?? state.slots.isbn,
    title: input.incomingSlots.title ?? state.slots.title,
    wantsRecommendations:
      input.incomingSlots.wantsRecommendations ?? state.slots.wantsRecommendations,
  };

  let intent = state.intent;
  if (state.awaitingInput !== "none" && (state.intent === "product" || state.intent === "order")) {
    intent = state.intent;
  } else if (input.intent !== "unknown") {
    intent = input.intent;
  }

  return {
    ...state,
    intent,
    slots,
    updatedAt: Date.now(),
  };
}

export function isSlotAnswerComplete(
  wasAwaiting: CallStateAwaitingInput,
  slots: CallStateSlots,
): boolean {
  if (wasAwaiting === "none") {
    return Boolean(slots.isbn);
  }
  if (wasAwaiting === "isbn_or_title") {
    return Boolean(slots.isbn || slots.title || slots.wantsRecommendations);
  }
  if (wasAwaiting === "isbn") return Boolean(slots.isbn);
  if (wasAwaiting === "title") return Boolean(slots.title);
  return false;
}

export function applyDecisionToCallState(
  state: CallState,
  decision: string,
): CallState {
  switch (decision) {
    case "ASK_QUESTION":
      if (state.intent === "product") {
        return { ...state, phase: "PHASE_1", awaitingInput: "isbn_or_title" };
      }
      if (state.intent === "order") {
        return { ...state, phase: "PHASE_1", awaitingInput: "order_number" };
      }
      return state;
    case "searchProductByISBN":
    case "searchProductByTitle":
    case "getSimilarProducts":
    case "orderLookupTool":
      return { ...state, phase: "PHASE_2", awaitingInput: "none" };
    case "conversationOnly":
      return { ...state, awaitingInput: "none" };
    default:
      return state;
  }
}

export function finalizeAfterToolExecution(state: CallState): CallState {
  return {
    ...state,
    phase: "PHASE_1",
    intent: "unknown",
    slots: {},
    awaitingInput: "none",
    updatedAt: Date.now(),
  };
}

export function clearCallState(callSid: string): void {
  states.delete(callSid);
}

export function clearAllCallStates(): void {
  states.clear();
}

/** Test helper */
export function callStateCount(): number {
  purgeExpired();
  return states.size;
}
