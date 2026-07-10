/**
 * Pure slot/memory merge primitives — shared by reducers and callStateStore unit tests.
 *
 * NO side effects, NO I/O. Conflict resolution priority:
 * explicit_override (collected slot flags) > collected_slot > memory > raw_stt
 */
import type { GateIntent } from "../agents/toolGateTypes.js";
import {
  buildProductSearchKey,
  normalizeTitle,
  type SlotMemorySyncLog,
} from "../agents/productRetrievalPolicy.js";
import { advanceProductAwaiting } from "../agents/productSlotPhase.js";
import type { SessionProductMemory } from "../memory/callMemoryStore.js";
import { emptyProductMemory } from "../memory/callMemoryStore.js";
import type {
  CallState,
  CallStateAwaitingInput,
  CallStateSlotFlags,
  CallStateSlots,
  ProductSlotValidation,
} from "../memory/callStateStore.js";
import type { IncomingProductSlots } from "../types/order.js";
import {
  digitizeSpeechForIsbn,
  extractIsbnFromAwaitingSpeech,
  isCompleteIsbnValue,
  normalizeIsbn,
} from "../utils/productSearchNormalize.js";

import {
  applyProductMemoryToCallState,
  applyDecisionToCallState,
  applyDecisionToCallStatePure,
  finalizeAfterToolExecution,
  ingestIncomingSlots,
  isSlotCollectedThisTurn,
  mergeSlotsCumulative,
  resolveStickyIntent,
  validateProductSlotState,
} from "../memory/callStateStore.js";

export {
  ingestIncomingSlots,
  mergeSlotsCumulative,
  resolveStickyIntent,
  applyDecisionToCallState,
  applyDecisionToCallStatePure,
  finalizeAfterToolExecution,
  applyProductMemoryToCallState,
  validateProductSlotState,
  isSlotCollectedThisTurn,
};

function partialIsbnDigits(value: string | undefined): string {
  if (!value) return "";
  if (isCompleteIsbnValue(value)) return "";
  return value.replace(/\D/g, "");
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

function ensurePersistentSlotFlags(
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

function resolvePriorPartialIsbn(state: Pick<CallState, "slots">, slots: CallStateSlots): string {
  return partialIsbnDigits(slots.isbn) || partialIsbnDigits(state.slots.isbn);
}

function applyIsbnAwaitingMerge(
  state: Pick<CallState, "slots">,
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

function resolveProductAwaiting(
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

/** Pure merge of incoming turn deltas into call-state (no persistence). */
export function pureMergeTurnIntoCallState(
  state: Pick<
    CallState,
    "intent" | "phase" | "awaitingInput" | "slots" | "slotFlags" | "updatedAt"
  >,
  input: {
    intent: GateIntent;
    incomingSlots: IncomingProductSlots;
    userMessage?: string;
  },
  now = Date.now(),
): Pick<CallState, "intent" | "phase" | "awaitingInput" | "slots" | "slotFlags" | "updatedAt"> {
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
  const resolvedFlags =
    titleChanged && wasAwaiting !== "title"
      ? { ...slotFlags, titleCollected: false }
      : slotFlags;

  const intent = resolveStickyIntent(
    state as CallState,
    input.intent,
    input.userMessage ?? "",
  );

  const productIntent = intent === "product" || input.intent === "product";
  const draft = { ...state, slots, slotFlags: resolvedFlags, intent };
  const awaitingInput = productIntent
    ? resolveProductAwaiting(draft, input.userMessage ?? "")
    : state.awaitingInput;

  return {
    ...draft,
    awaitingInput,
    updatedAt: now,
  };
}

/**
 * Pure slot → product memory sync with explicit conflict rules.
 * When ISBN/title identity changes, prior search keys are invalidated.
 */
export function pureSyncSlotsToProductMemory(
  prior: SessionProductMemory,
  slots: CallStateSlots,
  slotFlags: CallStateSlotFlags,
): SlotMemorySyncResult {
  const slotIsbn =
    slots.isbn && isCompleteIsbnValue(slots.isbn) ? normalizeIsbn(slots.isbn) : undefined;
  const slotTitle = slots.title ? normalizeTitle(slots.title) : undefined;

  let isbn = prior.isbn;
  let title = prior.title;
  let memoryWins = false;
  let searchKeyInvalidated = false;

  if (prior.isbn && slotIsbn && prior.isbn !== slotIsbn) {
    isbn = prior.isbn;
    memoryWins = true;
  } else if (!prior.isbn && slotIsbn) {
    isbn = slotIsbn;
  } else if (slotIsbn && slotFlags.isbnCollected) {
    if (prior.isbn && prior.isbn !== slotIsbn) searchKeyInvalidated = true;
    isbn = slotIsbn;
  } else if (prior.isbn) {
    isbn = prior.isbn;
    memoryWins = Boolean(slotIsbn && slotIsbn !== prior.isbn);
  }

  if (prior.title && slotTitle && prior.title.toLowerCase() !== slotTitle.toLowerCase()) {
    if (slotFlags.titleCollected) {
      title = slotTitle;
      searchKeyInvalidated = true;
    } else {
      title = prior.title;
      memoryWins = true;
    }
  } else if (!prior.title && slotTitle) {
    title = slotTitle;
  } else if (slotTitle && slotFlags.titleCollected) {
    if (prior.title && prior.title.toLowerCase() !== slotTitle.toLowerCase()) {
      searchKeyInvalidated = true;
    }
    title = slotTitle;
  } else if (prior.title) {
    title = prior.title;
  }

  const synced: SessionProductMemory = {
    isbn,
    title,
    lastSearchKey: searchKeyInvalidated ? undefined : prior.lastSearchKey,
    lastResultProductId: searchKeyInvalidated ? undefined : prior.lastResultProductId,
    isbnCollected:
      prior.isbnCollected ||
      slotFlags.isbnCollected ||
      Boolean(isbn && isCompleteIsbnValue(isbn)),
    titleCollected: prior.titleCollected || slotFlags.titleCollected,
  };

  return {
    memory: synced,
    log: {
      slotIsbn,
      slotTitle,
      memoryIsbn: synced.isbn,
      memoryTitle: synced.title,
      memoryWins,
      searchKey: buildProductSearchKey(synced),
    },
    searchKeyInvalidated,
  };
}

export interface SlotMemorySyncResult {
  memory: SessionProductMemory;
  log: SlotMemorySyncLog;
  searchKeyInvalidated: boolean;
}

export interface MemoryTurnMergeInput {
  intent: GateIntent;
  incomingSlots: IncomingProductSlots;
  userMessage?: string;
}

export interface MemoryTurnMergeResult {
  callStateSlice: Pick<
    CallState,
    "intent" | "phase" | "awaitingInput" | "slots" | "slotFlags" | "updatedAt"
  >;
  productMemory: SessionProductMemory;
  syncLog: SlotMemorySyncLog;
  wasAwaiting: CallStateAwaitingInput;
  slotsCollected: boolean;
  validation: ProductSlotValidation;
}

/** Full atomic memory turn — pure composition used by reducer MEMORY_SYNCD handler. */
export function pureCommitMemoryTurn(
  state: AgentStateSlice & { callSid: string },
  input: MemoryTurnMergeInput,
  now = Date.now(),
): MemoryTurnMergeResult {
  const wasAwaiting = state.awaitingInput;
  const merged = pureMergeTurnIntoCallState(state, input, now);
  const sync = pureSyncSlotsToProductMemory(state.product, merged.slots, merged.slotFlags);

  const withMemory = applyProductMemoryToCallState(
    {
      callSid: state.callSid,
      phase: merged.phase,
      intent: merged.intent,
      slots: merged.slots,
      slotFlags: merged.slotFlags,
      awaitingInput: merged.awaitingInput,
      updatedAt: merged.updatedAt,
    },
    sync.memory,
  );

  const slotsCollected = isSlotCollectedThisTurn(wasAwaiting, withMemory);
  const validation = validateProductSlotState(withMemory, sync.memory);

  return {
    callStateSlice: {
      intent: withMemory.intent,
      phase: withMemory.phase,
      awaitingInput: withMemory.awaitingInput,
      slots: withMemory.slots,
      slotFlags: withMemory.slotFlags,
      updatedAt: withMemory.updatedAt,
    },
    productMemory: sync.memory,
    syncLog: sync.log,
    wasAwaiting,
    slotsCollected,
    validation,
  };
}

/** Self-heal resync — slots re-projected into memory without new STT deltas. */
export function pureSelfHealResync(
  state: AgentStateSlice & { callSid: string },
  now = Date.now(),
): MemoryTurnMergeResult {
  const sync = pureSyncSlotsToProductMemory(state.product, state.slots, state.slotFlags);
  const withMemory = applyProductMemoryToCallState(
    {
      callSid: state.callSid,
      phase: state.phase,
      intent: state.intent,
      slots: state.slots,
      slotFlags: state.slotFlags,
      awaitingInput: state.awaitingInput,
      updatedAt: now,
    },
    sync.memory,
  );

  return {
    callStateSlice: {
      intent: withMemory.intent,
      phase: withMemory.phase,
      awaitingInput: withMemory.awaitingInput,
      slots: withMemory.slots,
      slotFlags: withMemory.slotFlags,
      updatedAt: withMemory.updatedAt,
    },
    productMemory: sync.memory,
    syncLog: sync.log,
    wasAwaiting: state.awaitingInput,
    slotsCollected: false,
    validation: validateProductSlotState(withMemory, sync.memory),
  };
}

export type AgentStateSlice = Pick<
  import("./agentState.js").AgentState,
  | "product"
  | "phase"
  | "intent"
  | "slots"
  | "slotFlags"
  | "awaitingInput"
  | "updatedAt"
>;
