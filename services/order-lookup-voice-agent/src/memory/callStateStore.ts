/**
 * Per-call state machine — single source of truth for slots, phase, and intent.
 */
import type { GateIntent } from "../agents/toolDecisionGate.js";
import { advanceProductAwaiting } from "../agents/productSlotPhase.js";
import { assertOrchestratorOnly } from "../guards/pipelineGuard.js";
import { normalizeIsbn } from "../utils/productSearchNormalize.js";
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

export interface CallStateSlotFlags {
  isbnCollected: boolean;
  titleCollected: boolean;
  recommendationsCollected: boolean;
}

export interface CallState {
  callSid: string;
  phase: CallStatePhase;
  intent: CallStateIntent;
  slots: CallStateSlots;
  slotFlags: CallStateSlotFlags;
  awaitingInput: CallStateAwaitingInput;
  updatedAt: number;
}

const EMPTY_SLOT_FLAGS: CallStateSlotFlags = {
  isbnCollected: false,
  titleCollected: false,
  recommendationsCollected: false,
};

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
    slotFlags: { ...EMPTY_SLOT_FLAGS },
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
  assertOrchestratorOnly("saveCallState", "callStateStore.ts");
  state.updatedAt = Date.now();
  states.set(state.callSid, state);
}

export interface ProductSlotValidation {
  ready: boolean;
  reason?:
    | "missing_slots"
    | "isbn_needs_confirmation"
    | "title_needs_confirmation"
    | "recommendations_needs_confirmation";
}

export interface AtomicTurnResult {
  state: CallState;
  wasAwaiting: CallStateAwaitingInput;
  slotsCollected: boolean;
  validation: ProductSlotValidation;
}

function normalizeIncomingIsbn(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = normalizeIsbn(value.trim());
  return normalized.length >= 10 ? normalized : undefined;
}

/** Merge slot deltas into persisted slots — never drop existing values. */
export function mergeSlotsCumulative(
  existing: CallStateSlots,
  delta: ProductSearchSlots,
): CallStateSlots {
  const merged: CallStateSlots = { ...existing };

  if (delta.isbn !== undefined && delta.isbn !== "") {
    const normalized = normalizeIncomingIsbn(delta.isbn);
    if (normalized) merged.isbn = normalized;
  }

  if (delta.title !== undefined && delta.title !== "") {
    merged.title = delta.title.trim();
  }

  if (delta.wantsRecommendations !== undefined) {
    merged.wantsRecommendations = delta.wantsRecommendations;
  }

  return merged;
}

/**
 * Validates product slots before any Shopify tool may run.
 * Uses persistent slotFlags — not transient turn signals.
 */
export function validateProductSlotState(state: CallState): ProductSlotValidation {
  if (state.intent !== "product") {
    return { ready: true };
  }

  const { slots, slotFlags } = state;

  if (slots.isbn && slotFlags.isbnCollected) {
    return { ready: true };
  }

  if (slots.title && slotFlags.titleCollected) {
    return { ready: true };
  }

  if (slots.wantsRecommendations && slotFlags.recommendationsCollected) {
    return { ready: true };
  }

  if (slots.isbn && !slotFlags.isbnCollected) {
    return { ready: false, reason: "isbn_needs_confirmation" };
  }

  if (slots.title && !slotFlags.titleCollected) {
    return { ready: false, reason: "title_needs_confirmation" };
  }

  if (slots.wantsRecommendations && !slotFlags.recommendationsCollected) {
    return { ready: false, reason: "recommendations_needs_confirmation" };
  }

  return { ready: false, reason: "missing_slots" };
}

export function isProductToolAction(decision: string): boolean {
  return (
    decision === "searchProductByISBN" ||
    decision === "searchProductByTitle" ||
    decision === "getSimilarProducts"
  );
}

function applySlotCollectionFlags(
  wasAwaiting: CallStateAwaitingInput,
  slots: CallStateSlots,
  flags: CallStateSlotFlags,
): CallStateSlotFlags {
  const next = { ...flags };

  if (wasAwaiting === "isbn" && slots.isbn) {
    next.isbnCollected = true;
  }
  if (wasAwaiting === "title" && slots.title) {
    next.titleCollected = true;
  }
  if (wasAwaiting === "isbn_or_title" && slots.wantsRecommendations) {
    next.recommendationsCollected = true;
  }

  return next;
}

/** Deterministic awaiting — never re-ask for collected slots. */
export function resolveProductAwaiting(
  state: Pick<CallState, "awaitingInput" | "slots" | "slotFlags">,
  speech: string,
): CallStateAwaitingInput {
  const { slots, slotFlags } = state;

  if (slotFlags.isbnCollected && slots.isbn) {
    if (state.awaitingInput === "title" && !slotFlags.titleCollected) {
      return "title";
    }
    return "none";
  }

  if (slotFlags.titleCollected && slots.title) {
    return "none";
  }

  if (slotFlags.recommendationsCollected && slots.wantsRecommendations) {
    return "none";
  }

  return advanceProductAwaiting(state.awaitingInput, speech, slots, slotFlags);
}

/**
 * Atomic turn update: read → merge deltas → validate → persist. No partial writes.
 */
export function atomicMergeTurnState(
  callSid: string,
  input: {
    intent: GateIntent;
    incomingSlots: ProductSearchSlots;
    userMessage?: string;
  },
): AtomicTurnResult {
  assertOrchestratorOnly("atomicMergeTurnState", "callStateStore.ts");
  const previous = getOrCreateCallState(callSid);
  const wasAwaiting = previous.awaitingInput;
  const merged = mergeTurnIntoCallState(previous, input);
  const slotsCollected = isSlotCollectedThisTurn(wasAwaiting, merged);
  const validation = validateProductSlotState(merged);

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
    userMessage?: string;
  },
): CallState {
  const wasAwaiting = state.awaitingInput;
  const slots = mergeSlotsCumulative(state.slots, input.incomingSlots);
  const slotFlags = applySlotCollectionFlags(wasAwaiting, slots, state.slotFlags);

  let intent = state.intent;
  if (state.awaitingInput !== "none" && (state.intent === "product" || state.intent === "order")) {
    intent = state.intent;
  } else if (input.intent !== "unknown") {
    intent = input.intent;
  }

  const productIntent = intent === "product" || input.intent === "product";
  const draft = { ...state, slots, slotFlags, intent };
  const awaitingInput = productIntent
    ? resolveProductAwaiting(draft, input.userMessage ?? "")
    : state.awaitingInput;

  return {
    ...draft,
    awaitingInput,
    updatedAt: Date.now(),
  };
}

export function isSlotCollectedThisTurn(
  wasAwaiting: CallStateAwaitingInput,
  state: CallState,
): boolean {
  if (wasAwaiting === "isbn") return state.slotFlags.isbnCollected;
  if (wasAwaiting === "title") return state.slotFlags.titleCollected;
  if (wasAwaiting === "isbn_or_title") return state.slotFlags.recommendationsCollected;
  return false;
}

/** @deprecated Use isSlotCollectedThisTurn + slotFlags */
export function isSlotAnswerComplete(
  wasAwaiting: CallStateAwaitingInput,
  slots: CallStateSlots,
): boolean {
  if (wasAwaiting === "isbn") return Boolean(slots.isbn);
  if (wasAwaiting === "title") return Boolean(slots.title);
  if (wasAwaiting === "isbn_or_title") return Boolean(slots.wantsRecommendations);
  return false;
}

function resolveAwaitingAfterAsk(state: CallState): CallStateAwaitingInput {
  const { slots, slotFlags, awaitingInput } = state;

  if (slotFlags.isbnCollected && slots.isbn) return "none";
  if (slotFlags.titleCollected && slots.title) return "none";

  if (awaitingInput === "isbn" && !slotFlags.isbnCollected) return "isbn";
  if (awaitingInput === "title" && !slotFlags.titleCollected) return "title";

  const resolved = resolveProductAwaiting(state, "");
  if (resolved !== "none") return resolved;

  const needsSlot =
    !slotFlags.isbnCollected &&
    !slotFlags.titleCollected &&
    !slotFlags.recommendationsCollected &&
    !slots.isbn &&
    !slots.title &&
    !slots.wantsRecommendations;

  return needsSlot ? "isbn_or_title" : "none";
}

export function applyDecisionToCallState(
  state: CallState,
  decision: string,
): CallState {
  assertOrchestratorOnly("applyDecisionToCallState", "callStateStore.ts");
  switch (decision) {
    case "ASK_QUESTION":
      if (state.intent === "product") {
        return { ...state, phase: "PHASE_1", awaitingInput: resolveAwaitingAfterAsk(state) };
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
    slotFlags: { ...EMPTY_SLOT_FLAGS },
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
