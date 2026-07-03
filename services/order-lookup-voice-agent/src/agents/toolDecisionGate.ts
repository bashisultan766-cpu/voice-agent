/**
 * Tool Decision Gate — deterministic only. SessionProductMemory is authoritative.
 */
import type {
  CallStateAwaitingInput,
  CallStatePhase,
} from "../memory/callStateStore.js";
import type { SessionProductMemory } from "../memory/callMemoryStore.js";
import {
  resolveProductToolAction,
  type ToolExecutionReason,
} from "./productRetrievalPolicy.js";
import type { ExecutionContextSnapshot } from "../runtime/executionContextSnapshot.js";
import { assertOrchestratorOnly } from "../guards/pipelineGuard.js";
import { pipelineTrace } from "../utils/pipelineTrace.js";
import type { ProductSearchSlots } from "../types/order.js";

export function computeMissingSlots(
  slots: Pick<ProductSearchSlots, "isbn" | "title">,
): Array<"isbn" | "title"> {
  const missing: Array<"isbn" | "title"> = [];
  if (!slots.isbn) missing.push("isbn");
  if (!slots.title) missing.push("title");
  return missing;
}

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
  productMemory: SessionProductMemory;
  validationReady: boolean;
  explicitRepeat: boolean;
  wantsRecommendations: boolean;
  orderNumber?: string | null;
}

export interface ToolDecisionResult {
  action: ToolAction;
  reason: ToolExecutionReason | "order_number_present" | "non_product_intent";
}

/** Deterministic tool execution decision — orchestrator only. */
export function decideToolExecution(state: ToolDecisionState): ToolAction {
  return decideToolExecutionWithReason(state).action;
}

export function decideToolExecutionWithReason(state: ToolDecisionState): ToolDecisionResult {
  assertOrchestratorOnly("decideToolExecution", "toolDecisionGate.ts");
  const result = decideToolExecutionCore(state);
  pipelineTrace({
    layer: "gate",
    file: "toolDecisionGate.ts",
    action: "decide",
    state: {
      intent: state.intent,
      validationReady: state.validationReady,
      productMemory: state.productMemory,
      decision: result.action,
      reason: result.reason,
    },
  });
  return result;
}

function decideToolExecutionCore(state: ToolDecisionState): ToolDecisionResult {
  if (state.intent === "general" || state.intent === "unknown") {
    return { action: "conversationOnly", reason: "non_product_intent" };
  }

  if (state.intent === "order") {
    if (state.orderNumber) {
      return { action: "orderLookupTool", reason: "order_number_present" };
    }
    return { action: "ASK_QUESTION", reason: "missing_memory" };
  }

  if (state.intent === "product") {
    const resolved = resolveProductToolAction(
      state.productMemory,
      state.validationReady,
      state.explicitRepeat,
      state.wantsRecommendations,
    );
    return { action: resolved.action, reason: resolved.reason };
  }

  return { action: "conversationOnly", reason: "non_product_intent" };
}

export function buildToolDecisionState(input: {
  intent: GateIntent;
  phase: CallStatePhase;
  awaitingInput: CallStateAwaitingInput;
  productMemory: SessionProductMemory;
  validationReady: boolean;
  explicitRepeat: boolean;
  wantsRecommendations?: boolean;
  orderNumber?: string | null;
}): ToolDecisionState {
  return {
    intent: input.intent,
    phase: input.phase,
    awaitingInput: input.awaitingInput,
    productMemory: input.productMemory,
    validationReady: input.validationReady,
    explicitRepeat: input.explicitRepeat,
    wantsRecommendations: Boolean(input.wantsRecommendations),
    orderNumber: input.orderNumber,
  };
}

/** Build gate input from a frozen execution snapshot — no live state reads. */
export function buildToolDecisionStateFromSnapshot(
  snapshot: ExecutionContextSnapshot,
  input: {
    intent: GateIntent;
    phase: CallStatePhase;
    awaitingInput: CallStateAwaitingInput;
    validationReady: boolean;
    orderNumber?: string | null;
  },
): ToolDecisionState {
  assertOrchestratorOnly("buildToolDecisionStateFromSnapshot", "toolDecisionGate.ts");
  return buildToolDecisionState({
    intent: input.intent,
    phase: input.phase,
    awaitingInput: input.awaitingInput,
    productMemory: snapshot.memory,
    validationReady: input.validationReady,
    explicitRepeat: snapshot.explicitRepeat,
    wantsRecommendations: snapshot.wantsRecommendations,
    orderNumber: input.orderNumber,
  });
}
