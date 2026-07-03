/**
 * Agent platform event envelope — immutable, replayable lifecycle contract.
 *
 * Phase 1: capture-only; reducers consume these events in Phase 2+.
 * Every event is a discriminated union validated at dispatch time via Zod.
 */
import { z } from "zod";
import type { GateIntent } from "../agents/toolDecisionGate.js";
import type { ToolAction } from "../agents/toolDecisionGate.js";
import type { SessionProductMemory } from "../memory/callMemoryStore.js";
import type { CallStateAwaitingInput, CallStatePhase, CallStateSlots, CallStateSlotFlags } from "../memory/callStateStore.js";

/** JSON-serializable memory + call-state slice stored in Postgres JSONB columns. */
export const callSnapshotSchema = z.object({
  product: z.object({
    isbn: z.string().optional(),
    title: z.string().optional(),
    lastSearchKey: z.string().optional(),
    lastResultProductId: z.string().optional(),
    isbnCollected: z.boolean(),
    titleCollected: z.boolean(),
  }),
  callState: z.object({
    intent: z.enum(["order", "product", "general", "unknown"]),
    phase: z.enum(["PHASE_1", "PHASE_2"]),
    awaitingInput: z.enum(["none", "isbn", "title", "isbn_or_title", "order_number"]),
    slots: z.object({
      isbn: z.string().optional(),
      title: z.string().optional(),
      wantsRecommendations: z.boolean().optional(),
    }),
    slotFlags: z.object({
      isbnCollected: z.boolean(),
      titleCollected: z.boolean(),
      recommendationsCollected: z.boolean(),
    }),
  }),
  lastOrderNumber: z.string().optional(),
});

export type CallSnapshot = z.infer<typeof callSnapshotSchema>;

const shopifyProductSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  isbns: z.array(z.string()).optional(),
  variantSkus: z.array(z.string()).optional(),
});

export const turnIngestedPayloadSchema = z.object({
  textLength: z.number().int().nonnegative(),
  source: z.enum(["orchestrator", "prompt", "dtmf", "router_speech"]).optional(),
  partial: z.boolean().optional(),
  /** Redacted preview — never log full PII in events; length + hash only in production. */
  textPreview: z.string().max(120).optional(),
  /** Full utterance for reducer message append (voice path only; omitted in redacted logs). */
  userMessage: z.string().optional(),
});

const incomingSlotsSchema = z.object({
  isbn: z.string().optional(),
  parsedIsbn: z.string().optional(),
  title: z.string().optional(),
  wantsRecommendations: z.boolean().optional(),
});

const memoryMergeInputSchema = z.object({
  intent: z.enum(["order", "product", "general", "unknown"]),
  incomingSlots: incomingSlotsSchema.optional(),
  userMessage: z.string().optional(),
});

export const memorySyncedPayloadSchema = z.object({
  searchKey: z.string().optional(),
  explicitRepeat: z.boolean().optional(),
  syncLog: z
    .object({
      slotIsbn: z.string().optional(),
      slotTitle: z.string().optional(),
      memoryIsbn: z.string().optional(),
      memoryTitle: z.string().optional(),
      memoryWins: z.boolean(),
      searchKey: z.string().optional(),
    })
    .optional(),
  /** True when partial ISBN digit accumulator was replaced by a complete ISBN. */
  isbnPartialCleared: z.boolean().optional(),
  selfHealApplied: z.boolean().optional(),
  memoryCommitTimestamp: z.number().optional(),
  /** Pure merge inputs — reducer applies atomic memory commit. */
  mergeInput: memoryMergeInputSchema.optional(),
  /** Re-sync slots → memory without new STT deltas (self-heal path). */
  selfHealResync: z.boolean().optional(),
});

export const toolSelectedPayloadSchema = z.object({
  tool: z.string(),
  reason: z.string(),
  searchKey: z.string().optional(),
  validationReady: z.boolean(),
  intent: z.enum(["order", "product", "general", "unknown"]),
  flow: z.enum(["PRODUCT_FLOW", "ORDER_FLOW", "MIXED_FLOW", "UNKNOWN_FLOW"]),
  /** Gate decision applied by reducer (ASK_QUESTION, searchProductByISBN, etc.). */
  gateDecision: z.string().optional(),
});

export const executionFrozenPayloadSchema = z.object({
  frozenAt: z.number(),
  searchKey: z.string().optional(),
  explicitRepeat: z.boolean().optional(),
});

export const toolExecutionStartedPayloadSchema = z.object({
  tool: z.string(),
  searchKey: z.string().optional(),
  strictRetry: z.boolean().optional(),
  excludeProductId: z.string().optional(),
});

export const toolExecutionCompletedPayloadSchema = z.object({
  tool: z.string(),
  status: z.enum(["found", "not_found", "error", "empty"]),
  resultCount: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative().optional(),
  strictRetry: z.boolean().optional(),
  /** Summarized Shopify rows — not full GraphQL payloads (size + replay safety). */
  products: z.array(shopifyProductSummarySchema).optional(),
  orderStatus: z.string().optional(),
});

export const validationResultPayloadSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  passed: z.boolean(),
  reasons: z.array(z.string()).optional(),
  strictRetry: z.boolean().optional(),
  stage: z.string().optional(),
});

export const degradedModePayloadSchema = z.object({
  reason: z.enum(["THROTTLED", "CIRCUIT_OPEN", "API_TIMEOUT"]),
  retryAfterMs: z.number().int().nonnegative().optional(),
  operation: z.string().optional(),
  circuitState: z.enum(["OPEN", "HALF_OPEN"]).optional(),
});

export const responseSentPayloadSchema = z.object({
  responseType: z.string(),
  speechLength: z.number().int().nonnegative(),
  searchKind: z.string().optional(),
  speech: z.string().optional(),
  finalizeToolExecution: z.boolean().optional(),
  recordOrderNumber: z.string().optional(),
  recordProduct: z
    .object({
      id: z.string(),
      title: z.string(),
      searchKey: z.string().optional(),
    })
    .optional(),
  /** Next slot the fulfillment router should prioritize on the following turn. */
  fulfillmentAwaitingSlot: z.enum(["order_number", "title", "isbn"]).optional(),
  /** True when the deterministic fulfillment stack handled this turn (not legacy gate). */
  fulfillmentFlow: z.boolean().optional(),
});

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TURN_INGESTED"), payload: turnIngestedPayloadSchema }),
  z.object({ type: z.literal("MEMORY_SYNCD"), payload: memorySyncedPayloadSchema }),
  z.object({ type: z.literal("TOOL_SELECTED"), payload: toolSelectedPayloadSchema }),
  z.object({ type: z.literal("EXECUTION_FROZEN"), payload: executionFrozenPayloadSchema }),
  z.object({ type: z.literal("TOOL_EXECUTION_STARTED"), payload: toolExecutionStartedPayloadSchema }),
  z.object({ type: z.literal("TOOL_EXECUTION_COMPLETED"), payload: toolExecutionCompletedPayloadSchema }),
  z.object({ type: z.literal("VALIDATION_RESULT"), payload: validationResultPayloadSchema }),
  z.object({ type: z.literal("DEGRADED_MODE"), payload: degradedModePayloadSchema }),
  z.object({ type: z.literal("RESPONSE_SENT"), payload: responseSentPayloadSchema }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

export type AgentEventType = AgentEvent["type"];

/** Persisted envelope written to in-memory store and Postgres. */
export interface StoredAgentEvent {
  id: string;
  callSid: string;
  turnSeq: number;
  eventType: AgentEventType;
  eventVersion: number;
  payload: AgentEvent["payload"];
  memoryBefore: CallSnapshot | null;
  memoryAfter: CallSnapshot | null;
  latencyMs: number | null;
  createdAt: number;
}

export function parseAgentEvent(raw: unknown): AgentEvent {
  return agentEventSchema.parse(raw);
}

export function snapshotFromMemory(
  product: SessionProductMemory,
  callState: {
    intent: GateIntent;
    phase: CallStatePhase;
    awaitingInput: CallStateAwaitingInput;
    slots: CallStateSlots;
    slotFlags: CallStateSlotFlags;
  },
  lastOrderNumber?: string,
): CallSnapshot {
  return {
    product: structuredClone(product),
    callState: {
      intent: callState.intent,
      phase: callState.phase,
      awaitingInput: callState.awaitingInput,
      slots: structuredClone(callState.slots),
      slotFlags: structuredClone(callState.slotFlags),
    },
    lastOrderNumber,
  };
}

export function summarizeShopifyProducts(
  products: Array<{ id: string; title: string; isbns?: string[]; variants: Array<{ sku?: string }> }>,
): z.infer<typeof shopifyProductSummarySchema>[] {
  return products.slice(0, 5).map((p) => ({
    id: p.id,
    title: p.title,
    isbns: p.isbns,
    variantSkus: p.variants.map((v) => v.sku).filter((s): s is string => Boolean(s)),
  }));
}

export type ToolActionName = ToolAction;
