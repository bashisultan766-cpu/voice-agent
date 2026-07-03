/**
 * Production turn observability — mandatory logs per SaaS agent platform spec.
 */
import { logger } from "../utils/logger.js";
import type { SessionProductMemory } from "../memory/callMemoryStore.js";
import type { GateIntent } from "../agents/toolDecisionGate.js";
import type { ToolAction } from "../agents/toolDecisionGate.js";

export type ExecutionFlow = "PRODUCT_FLOW" | "ORDER_FLOW" | "MIXED_FLOW" | "UNKNOWN_FLOW";

export type FinalResponseType =
  | "confirmed_product"
  | "fail_safe_alternatives"
  | "not_found"
  | "clarification_question"
  | "order_found"
  | "order_not_found"
  | "order_api_error"
  | "conversation_only"
  | "general_help"
  | "error";

export function resolveExecutionFlow(
  intent: GateIntent,
  orderNumber?: string | null,
  productSearchReady = false,
): ExecutionFlow {
  const product = intent === "product" || productSearchReady;
  const order = intent === "order" || Boolean(orderNumber?.trim());
  if (product && order) return "MIXED_FLOW";
  if (product) return "PRODUCT_FLOW";
  if (order) return "ORDER_FLOW";
  return "UNKNOWN_FLOW";
}

/** STEP 1 — event ingestion (stream layer). */
export function logEventIngestion(
  callSid: string,
  input: {
    source: "prompt" | "dtmf" | "router_speech";
    textLength: number;
    partial: boolean;
    queueDepth?: number;
  },
): void {
  logger.info("event_ingestion", {
    callSid: callSid.slice(0, 8),
    pipelineStep: 1,
    ...input,
  });
}

/** STEP 2 — memory reconciliation snapshot. */
export function logMemorySnapshot(
  callSid: string,
  productMemory: SessionProductMemory,
  extra?: Record<string, unknown>,
): void {
  logger.info("memory_snapshot", {
    callSid: callSid.slice(0, 8),
    pipelineStep: 2,
    isbn: productMemory.isbn,
    title: productMemory.title,
    isbnCollected: productMemory.isbnCollected,
    titleCollected: productMemory.titleCollected,
    lastSearchKey: productMemory.lastSearchKey,
    lastResultProductId: productMemory.lastResultProductId,
    ...extra,
  });
}

/** STEP 3 — intent + flow resolution. */
export function logIntentDecided(
  callSid: string,
  input: {
    intent: GateIntent;
    flow: ExecutionFlow;
    source: string;
    orderNumber?: string | null;
    explicitRepeat?: boolean;
  },
): void {
  logger.info("intent_decided", {
    callSid: callSid.slice(0, 8),
    pipelineStep: 3,
    ...input,
  });
}

/** STEP 4 — deterministic tool routing. */
export function logToolSelected(
  callSid: string,
  input: {
    tool: ToolAction;
    reason: string;
    searchKey?: string;
    validationReady: boolean;
  },
): void {
  logger.info("tool_selected", {
    callSid: callSid.slice(0, 8),
    pipelineStep: 4,
    ...input,
  });
}

/** STEP 5 — execution context frozen. */
export function logExecutionFreeze(
  callSid: string,
  input: { frozenAt: number; searchKey?: string },
): void {
  logger.info("execution_freeze", {
    callSid: callSid.slice(0, 8),
    pipelineStep: 5,
    ...input,
  });
}

/** STEP 6 — API execution outcome. */
export function logToolExecutionResult(
  callSid: string,
  input: {
    tool: string;
    status: "found" | "not_found" | "error" | "empty";
    resultCount: number;
    elapsedMs?: number;
    strictRetry?: boolean;
  },
): void {
  logger.info("tool_execution_result", {
    callSid: callSid.slice(0, 8),
    pipelineStep: 6,
    ...input,
  });
}

/** STEP 7 — validation engine outcome. */
export function logValidationResult(
  callSid: string,
  input: {
    accepted: number;
    rejected: number;
    passed: boolean;
    reasons?: string[];
    strictRetry?: boolean;
  },
): void {
  logger.info("validation_result", {
    callSid: callSid.slice(0, 8),
    pipelineStep: 7,
    ...input,
  });
}

/** Self-heal trigger (Reliability team). */
export function logSelfHealTriggered(
  callSid: string,
  reasons: string[],
): void {
  logger.info("self_heal_triggered", {
    callSid: callSid.slice(0, 8),
    reasons,
  });
}

/** STEP 9 — response delivery classification. */
export function logFinalResponseType(
  callSid: string,
  responseType: FinalResponseType,
  extra?: Record<string, unknown>,
): void {
  logger.info("final_response_type", {
    callSid: callSid.slice(0, 8),
    pipelineStep: 9,
    responseType,
    ...extra,
  });
}
