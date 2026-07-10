/**
 * Per-call state machine — single source of truth for slots, phase, and intent.
 */
import type { GateIntent } from "../agents/toolGateTypes.js";
import { advanceProductAwaiting } from "../agents/productSlotPhase.js";
import { assertOrchestratorOnly } from "../guards/pipelineGuard.js";
import {
  digitizeSpeechForIsbn,
  extractIsbnFromAwaitingSpeech,
  isCompleteIsbnValue,
  normalizeIsbn,
} from "../utils/productSearchNormalize.js";
import type { IncomingProductSlots, ProductSearchSlots } from "../types/order.js";
import { emptyProductMemory, type CallMemory, type SessionProductMemory } from "./callMemoryStore.js";
import {
  buildProductSearchKey,
  normalizeTitle,
  type SlotMemorySyncLog,
} from "../agents/productRetrievalPolicy.js";

export type CallStatePhase = "PHASE_1" | "PHASE_2";
export type CallStateIntent = GateIntent;
export type CallStateAwaitingInput =
  | "none"
  | "isbn"
  | "title"
  | "isbn_or_title"
  | "order_number";

export interface CallStateSlots extends ProductSearchSlots {
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
  productMemory: SessionProductMemory;
  syncLog?: SlotMemorySyncLog;
  memoryCommitTimestamp?: number;
}

function normalizeIncomingIsbn(value: string): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = normalizeIsbn(value.trim());
  return normalized.length >= 10 ? normalized : undefined;
}

function storeIsbnValue(raw: string): string {
  const complete = normalizeIncomingIsbn(raw);
  if (complete) return complete;
  return raw.replace(/\D/g, "").slice(0, 17);
}

/** Map extractor output (including parsedIsbn alias) to canonical ProductSearchSlots. */
export function ingestIncomingSlots(delta: IncomingProductSlots): ProductSearchSlots {
  const rawIsbn = delta.isbn ?? delta.parsedIsbn;
  const ingested: ProductSearchSlots = {};

  if (delta.title?.trim()) {
    ingested.title = delta.title.trim();
  }

  if (rawIsbn?.trim()) {
    ingested.isbn = storeIsbnValue(rawIsbn.trim());
  }

  return ingested;
}

function partialIsbnDigits(value: string | undefined): string {
  if (!value) return "";
  if (isCompleteIsbnValue(value)) return "";
  return value.replace(/\D/g, "");
}

/** Merge slot deltas into persisted slots — never drop or weaken existing values. */
export function mergeSlotsCumulative(
  existing: CallStateSlots,
  delta: IncomingProductSlots,
): CallStateSlots {
  const incoming = ingestIncomingSlots(delta);
  const merged: CallStateSlots = { ...existing };

  if (incoming.isbn !== undefined && incoming.isbn !== "") {
    const existingComplete = merged.isbn ? isCompleteIsbnValue(merged.isbn) : false;
    const incomingComplete = isCompleteIsbnValue(incoming.isbn);
    const normalizedIncoming = incomingComplete ? normalizeIsbn(incoming.isbn) : incoming.isbn;

    if (!merged.isbn) {
      merged.isbn = normalizedIncoming;
    } else if (existingComplete && !incomingComplete) {
      // Keep stored complete ISBN — never replace with partial or weaker data.
    } else if (incomingComplete && existingComplete) {
      if (normalizeIsbn(merged.isbn) !== normalizedIncoming) {
        merged.isbn = normalizedIncoming;
      }
    } else if (incomingComplete) {
      merged.isbn = normalizedIncoming;
    } else if (!existingComplete) {
      const existingPartial = partialIsbnDigits(merged.isbn);
      if (normalizedIncoming.length > existingPartial.length) {
        merged.isbn = normalizedIncoming;
      }
    }
  }

  if (incoming.title !== undefined && incoming.title !== "") {
    const nextTitle = incoming.title.trim();
    const isNewTitleEntity =
      merged.title && nextTitle.toLowerCase() !== merged.title.trim().toLowerCase();
    if (!merged.title || nextTitle.length >= merged.title.trim().length || isNewTitleEntity) {
      merged.title = nextTitle;
    }
    if (isNewTitleEntity) {
      merged.wantsRecommendations = undefined;
    }
  }

  if (delta.wantsRecommendations !== undefined) {
    merged.wantsRecommendations = delta.wantsRecommendations;
  }

  return merged;
}

/**
 * Validates product slots before any Shopify tool may run.
 * Uses SessionProductMemory as authoritative — slots are advisory only.
 */
export function validateProductSlotState(
  state: CallState,
  productMemory: SessionProductMemory,
): ProductSlotValidation {
  if (state.intent !== "product") {
    return { ready: true };
  }

  if (productMemory.isbn && productMemory.isbnCollected && isCompleteIsbnValue(productMemory.isbn)) {
    return { ready: true };
  }

  if (productMemory.title && productMemory.titleCollected) {
    return { ready: true };
  }

  if (state.slots.wantsRecommendations && state.slotFlags.recommendationsCollected) {
    return { ready: true };
  }

  if (productMemory.isbn && !productMemory.isbnCollected) {
    return { ready: false, reason: "isbn_needs_confirmation" };
  }

  if (productMemory.title && !productMemory.titleCollected) {
    return { ready: false, reason: "title_needs_confirmation" };
  }

  if (state.slots.wantsRecommendations && !state.slotFlags.recommendationsCollected) {
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

  if (wasAwaiting === "isbn" && slots.isbn && isCompleteIsbnValue(slots.isbn)) {
    next.isbnCollected = true;
    slots.isbn = normalizeIsbn(slots.isbn);
  }
  if (wasAwaiting === "title" && slots.title) {
    next.titleCollected = true;
  }
  if (wasAwaiting === "isbn_or_title" && slots.wantsRecommendations) {
    next.recommendationsCollected = true;
  }

  return next;
}

/** Promote collection flags when session memory already holds usable slot values. */
export function ensurePersistentSlotFlags(
  flags: CallStateSlotFlags,
  slots: CallStateSlots,
): CallStateSlotFlags {
  return {
    isbnCollected:
      flags.isbnCollected || Boolean(slots.isbn && isCompleteIsbnValue(slots.isbn)),
    titleCollected: flags.titleCollected,
    recommendationsCollected:
      flags.recommendationsCollected || Boolean(slots.wantsRecommendations),
  };
}

function isExplicitTopicChange(
  current: CallStateIntent,
  incoming: GateIntent,
  message: string,
): boolean {
  if (incoming === "unknown" || incoming === current) return false;

  if (current === "product" && incoming === "order") {
    return /\b(order|tracking|track|shipment|refund|where is my)\b/i.test(message);
  }
  if (current === "order" && incoming === "product") {
    return /\b(book|books|isbn|title|buy|purchase|catalog|magazine)\b/i.test(message);
  }
  if (incoming === "general" && /\b(never mind|forget that|stop|cancel)\b/i.test(message)) {
    return true;
  }
  return false;
}

/** Keep session intent sticky unless the caller explicitly changes topic. */
export function resolveStickyIntent(
  state: CallState,
  incoming: GateIntent,
  userMessage: string,
): CallStateIntent {
  const current = state.intent;

  if (state.awaitingInput !== "none" && (current === "product" || current === "order")) {
    return current;
  }

  if (incoming === "unknown") {
    return current;
  }

  if (current === "unknown" || current === "general") {
    return incoming;
  }

  if (incoming !== current && isExplicitTopicChange(current, incoming, userMessage)) {
    return incoming;
  }

  return current;
}

export interface SlotMemorySyncResult {
  memory: SessionProductMemory;
  log: SlotMemorySyncLog;
}

/**
 * HARD SYNC: merge ephemeral slots into SessionProductMemory.
 * On conflict, memory wins unless slots carry a newly collected value this turn.
 */
export function syncSlotsToProductMemory(
  callMemory: CallMemory,
  slots: CallStateSlots,
  slotFlags: CallStateSlotFlags,
): SlotMemorySyncResult {
  const prior = callMemory.product ?? emptyProductMemory();

  const slotIsbn =
    slots.isbn && isCompleteIsbnValue(slots.isbn) ? normalizeIsbn(slots.isbn) : undefined;
  const slotTitle = slots.title ? normalizeTitle(slots.title) : undefined;

  let isbn = prior.isbn;
  let title = prior.title;
  let memoryWins = false;

  if (prior.isbn && slotIsbn && prior.isbn !== slotIsbn) {
    isbn = prior.isbn;
    memoryWins = true;
  } else if (!prior.isbn && slotIsbn) {
    isbn = slotIsbn;
  } else if (slotIsbn && slotFlags.isbnCollected) {
    isbn = slotIsbn;
  } else if (prior.isbn) {
    isbn = prior.isbn;
    memoryWins = Boolean(slotIsbn && slotIsbn !== prior.isbn);
  }

  if (prior.title && slotTitle && prior.title.toLowerCase() !== slotTitle.toLowerCase()) {
    if (slotFlags.titleCollected) {
      title = slotTitle;
    } else {
      title = prior.title;
      memoryWins = true;
    }
  } else if (!prior.title && slotTitle) {
    title = slotTitle;
  } else if (slotTitle && slotFlags.titleCollected) {
    title = slotTitle;
  } else if (prior.title) {
    title = prior.title;
  }

  const synced: SessionProductMemory = {
    isbn,
    title,
    lastSearchKey: prior.lastSearchKey,
    lastResultProductId: prior.lastResultProductId,
    isbnCollected:
      prior.isbnCollected ||
      slotFlags.isbnCollected ||
      Boolean(isbn && isCompleteIsbnValue(isbn)),
    titleCollected: prior.titleCollected || slotFlags.titleCollected,
  };

  callMemory.product = synced;

  return {
    memory: synced,
    log: {
      slotIsbn: slotIsbn,
      slotTitle: slotTitle,
      memoryIsbn: synced.isbn,
      memoryTitle: synced.title,
      memoryWins,
      searchKey: buildProductSearchKey(synced),
    },
  };
}

/** Mirror authoritative memory back into ephemeral call-state slots. */
export function applyProductMemoryToCallState(
  state: CallState,
  productMemory: SessionProductMemory,
): CallState {
  return {
    ...state,
    slots: {
      ...state.slots,
      isbn: productMemory.isbn ?? state.slots.isbn,
      title: productMemory.title ?? state.slots.title,
    },
    slotFlags: {
      ...state.slotFlags,
      isbnCollected: productMemory.isbnCollected,
      titleCollected: productMemory.titleCollected,
    },
    updatedAt: Date.now(),
  };
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
 * Atomic memory commit — sync slots → memory → call state before gate/tools.
 * Explicit async yields prevent partial commit under concurrent voice events.
 */
export async function commitMemoryTurnAtomic(
  callSid: string,
  input: {
    intent: GateIntent;
    incomingSlots: IncomingProductSlots;
    userMessage?: string;
  },
  callMemory: CallMemory,
): Promise<AtomicTurnResult> {
  assertOrchestratorOnly("commitMemoryTurnAtomic", "callStateStore.ts");
  const previous = getOrCreateCallState(callSid);
  const wasAwaiting = previous.awaitingInput;
  let merged = mergeTurnIntoCallState(previous, input);

  await Promise.resolve();
  const sync = syncSlotsToProductMemory(callMemory, merged.slots, merged.slotFlags);
  const memoryCommitTimestamp = Date.now();

  await Promise.resolve();
  merged = applyProductMemoryToCallState(merged, sync.memory);

  await Promise.resolve();
  const productMemory = sync.memory;
  const slotsCollected = isSlotCollectedThisTurn(wasAwaiting, merged);
  const validation = validateProductSlotState(merged, productMemory);
  saveCallState(merged);

  return {
    state: getOrCreateCallState(callSid),
    wasAwaiting,
    slotsCollected,
    validation,
    productMemory,
    syncLog: sync.log,
    memoryCommitTimestamp,
  };
}

/**
 * Atomic turn update: read → merge deltas → validate → persist. No partial writes.
 */
export function atomicMergeTurnState(
  callSid: string,
  input: {
    intent: GateIntent;
    incomingSlots: IncomingProductSlots;
    userMessage?: string;
  },
  callMemory?: CallMemory,
): AtomicTurnResult {
  assertOrchestratorOnly("atomicMergeTurnState", "callStateStore.ts");
  const previous = getOrCreateCallState(callSid);
  const wasAwaiting = previous.awaitingInput;
  let merged = mergeTurnIntoCallState(previous, input);

  let productMemory: SessionProductMemory = callMemory?.product ?? emptyProductMemory();
  let syncLog: SlotMemorySyncLog | undefined;
  if (callMemory) {
    const sync = syncSlotsToProductMemory(callMemory, merged.slots, merged.slotFlags);
    productMemory = sync.memory;
    syncLog = sync.log;
    merged = applyProductMemoryToCallState(merged, productMemory);
  }

  const slotsCollected = isSlotCollectedThisTurn(wasAwaiting, merged);
  const validation = validateProductSlotState(merged, productMemory);

  saveCallState(merged);

  return {
    state: getOrCreateCallState(callSid),
    wasAwaiting,
    slotsCollected,
    validation,
    productMemory,
    syncLog,
  };
}

function resolvePriorPartialIsbn(state: CallState, slots: CallStateSlots): string {
  return partialIsbnDigits(slots.isbn) || partialIsbnDigits(state.slots.isbn);
}

function applyIsbnAwaitingMerge(
  state: CallState,
  userMessage: string,
  slots: CallStateSlots,
): CallStateSlots {
  if (slots.isbn && isCompleteIsbnValue(slots.isbn)) {
    return { ...slots, isbn: normalizeIsbn(slots.isbn) };
  }

  const priorPartial = resolvePriorPartialIsbn(state, slots);
  const complete = extractIsbnFromAwaitingSpeech(userMessage, priorPartial);

  if (complete && isCompleteIsbnValue(complete)) {
    return { ...slots, isbn: normalizeIsbn(complete) };
  }

  const chunk = digitizeSpeechForIsbn(userMessage);
  if (!chunk) return slots;

  const partial = `${priorPartial}${chunk}`.slice(0, 17);
  return { ...slots, isbn: partial };
}

export function mergeTurnIntoCallState(
  state: CallState,
  input: {
    intent: GateIntent;
    incomingSlots: IncomingProductSlots;
    userMessage?: string;
  },
): CallState {
  const wasAwaiting = state.awaitingInput;
  let slots = mergeSlotsCumulative(state.slots, input.incomingSlots);

  if (wasAwaiting === "isbn" && input.userMessage) {
    slots = applyIsbnAwaitingMerge(state, input.userMessage, slots);
  }

  const slotFlags = ensurePersistentSlotFlags(
    applySlotCollectionFlags(wasAwaiting, slots, state.slotFlags),
    slots,
  );

  const priorTitle = state.slots.title?.trim().toLowerCase();
  const nextTitle = slots.title?.trim().toLowerCase();
  const titleChanged = Boolean(priorTitle && nextTitle && priorTitle !== nextTitle);
  const resolvedFlags = titleChanged && wasAwaiting !== "title"
    ? { ...slotFlags, titleCollected: false }
    : slotFlags;

  const intent = resolveStickyIntent(state, input.intent, input.userMessage ?? "");

  const productIntent = intent === "product" || input.intent === "product";
  const draft = { ...state, slots, slotFlags: resolvedFlags, intent };
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
  if (wasAwaiting === "isbn") return Boolean(slots.isbn && isCompleteIsbnValue(slots.isbn));
  if (wasAwaiting === "title") return Boolean(slots.title);
  if (wasAwaiting === "isbn_or_title") return Boolean(slots.wantsRecommendations);
  return false;
}

function resolveAwaitingAfterAsk(state: CallState): CallStateAwaitingInput {
  const { slots, slotFlags, awaitingInput } = state;

  if (slots.isbn && isCompleteIsbnValue(slots.isbn) && slotFlags.isbnCollected) return "none";
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
    !(slots.isbn && isCompleteIsbnValue(slots.isbn)) &&
    !slots.title &&
    !slots.wantsRecommendations;

  return needsSlot ? "isbn_or_title" : "none";
}

export function applyDecisionToCallState(
  state: CallState,
  decision: string,
): CallState {
  assertOrchestratorOnly("applyDecisionToCallState", "callStateStore.ts");
  return applyDecisionToCallStatePure(state, decision);
}

/** Pure gate-decision projection — safe for offline replay / reducers. */
export function applyDecisionToCallStatePure(state: CallState, decision: string): CallState {
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
  const slotFlags = ensurePersistentSlotFlags(state.slotFlags, state.slots);
  return {
    ...state,
    phase: "PHASE_1",
    slotFlags,
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
