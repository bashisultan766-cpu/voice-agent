/**
 * Tool Decision Gate — ONLY module allowed to decide tool execution.
 * Decisions use persisted call state, not only the current utterance.
 */
import type {
  CallStateAwaitingInput,
  CallStatePhase,
  CallStateSlots,
} from "../memory/callStateStore.js";
import type { ProductSearchSlots } from "../types/order.js";

export type GateIntent = "order" | "product" | "general" | "unknown";

export type ToolAction =
  | "ASK_QUESTION"
  | "searchProductByISBN"
  | "searchProductByTitle"
  | "getSimilarProducts"
  | "orderLookupTool"
  | "conversationOnly";

export interface ToolDecisionState {
  intent: GateIntent;
  phase: CallStatePhase;
  awaitingInput: CallStateAwaitingInput;
  slots: Pick<ProductSearchSlots, "isbn" | "title" | "wantsRecommendations">;
  missingSlots: Array<"isbn" | "title">;
  /** Caller answered a prior slot question this turn. */
  slotsCollected: boolean;
  orderNumber?: string | null;
}

export function computeMissingSlots(
  slots: Pick<ProductSearchSlots, "isbn" | "title">,
): Array<"isbn" | "title"> {
  const missing: Array<"isbn" | "title"> = [];
  if (!slots.isbn) missing.push("isbn");
  if (!slots.title) missing.push("title");
  return missing;
}

/** Deterministic tool execution decision — uses persisted state. */
export function decideToolExecution(state: ToolDecisionState): ToolAction {
  const decision = decideToolExecutionCore(state);
  console.log({
    stage: "tool_gate",
    action: "decide",
    intent: state.intent,
    phase: state.phase,
    awaitingInput: state.awaitingInput,
    slots: state.slots,
    slotsCollected: state.slotsCollected,
    decision,
  });
  return decision;
}

function decideToolExecutionCore(state: ToolDecisionState): ToolAction {
  if (state.intent === "general" || state.intent === "unknown") {
    return "conversationOnly";
  }

  if (state.intent === "order") {
    if (state.orderNumber) return "orderLookupTool";
    return "ASK_QUESTION";
  }

  if (state.intent === "product") {
    const hasIsbn = Boolean(state.slots.isbn);
    const hasTitle = Boolean(state.slots.title);
    const wantsRec = Boolean(state.slots.wantsRecommendations);

    if (!hasIsbn && !hasTitle && !wantsRec) {
      return "ASK_QUESTION";
    }

    if (hasIsbn) {
      return "searchProductByISBN";
    }

    if (hasTitle && state.slotsCollected) {
      return "searchProductByTitle";
    }

    if (wantsRec && state.slotsCollected) {
      return "getSimilarProducts";
    }

    return "ASK_QUESTION";
  }

  return "conversationOnly";
}

export function buildToolDecisionState(input: {
  intent: GateIntent;
  phase: CallStatePhase;
  awaitingInput: CallStateAwaitingInput;
  slots: CallStateSlots;
  slotsCollected: boolean;
  orderNumber?: string | null;
}): ToolDecisionState {
  return {
    intent: input.intent,
    phase: input.phase,
    awaitingInput: input.awaitingInput,
    slots: {
      isbn: input.slots.isbn,
      title: input.slots.title,
      wantsRecommendations: input.slots.wantsRecommendations,
    },
    missingSlots: computeMissingSlots(input.slots),
    slotsCollected: input.slotsCollected,
    orderNumber: input.orderNumber,
  };
}
