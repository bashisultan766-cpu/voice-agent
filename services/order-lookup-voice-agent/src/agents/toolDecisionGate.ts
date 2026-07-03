/**
 * Tool Decision Gate — ONLY module allowed to decide tool execution.
 * Decisions use persisted call state, not only the current utterance.
 */
import type {
  CallStateAwaitingInput,
  CallStatePhase,
  CallStateSlots,
} from "../memory/callStateStore.js";
import { assertOrchestratorOnly } from "../guards/pipelineGuard.js";
import { pipelineTrace } from "../utils/pipelineTrace.js";
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
  /** Single source of truth — product tools require validation.ready === true. */
  validationReady: boolean;
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

/** Deterministic tool execution decision — orchestrator only. */
export function decideToolExecution(state: ToolDecisionState): ToolAction {
  assertOrchestratorOnly("decideToolExecution", "toolDecisionGate.ts");
  const decision = decideToolExecutionCore(state);
  pipelineTrace({
    layer: "gate",
    file: "toolDecisionGate.ts",
    action: "decide",
    state: {
      intent: state.intent,
      validationReady: state.validationReady,
      slots: state.slots,
      decision,
    },
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
    if (!state.validationReady) {
      return "ASK_QUESTION";
    }

    const hasIsbn = Boolean(state.slots.isbn);
    const hasTitle = Boolean(state.slots.title);
    const wantsRec = Boolean(state.slots.wantsRecommendations);

    if (hasIsbn) return "searchProductByISBN";
    if (hasTitle) return "searchProductByTitle";
    if (wantsRec) return "getSimilarProducts";

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
  validationReady: boolean;
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
    validationReady: input.validationReady,
    orderNumber: input.orderNumber,
  };
}
