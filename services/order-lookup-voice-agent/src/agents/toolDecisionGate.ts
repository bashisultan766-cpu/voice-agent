/**
 * Tool Decision Gate — ONLY module allowed to decide tool execution.
 * LLM / brain output is input; this layer is fully deterministic.
 */
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
  slots: Pick<ProductSearchSlots, "isbn" | "title" | "wantsRecommendations">;
  missingSlots: Array<"isbn" | "title">;
  /** True after caller responded to a product slot question. */
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

/** Deterministic tool execution decision — no LLM involvement. */
export function decideToolExecution(state: ToolDecisionState): ToolAction {
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
    const bothMissing =
      state.missingSlots.includes("isbn") && state.missingSlots.includes("title");

    if (!hasIsbn && !hasTitle && !wantsRec) {
      return "ASK_QUESTION";
    }

    if (bothMissing && !wantsRec) {
      return "ASK_QUESTION";
    }

    if (hasIsbn) {
      return "searchProductByISBN";
    }

    if (hasTitle && !state.slotsCollected) {
      return "ASK_QUESTION";
    }

    if (hasTitle && state.slotsCollected) {
      return "searchProductByTitle";
    }

    if (wantsRec && !state.slotsCollected) {
      return "ASK_QUESTION";
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
  slots: ProductSearchSlots;
  slotsCollected: boolean;
  orderNumber?: string | null;
}): ToolDecisionState {
  return {
    intent: input.intent,
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
