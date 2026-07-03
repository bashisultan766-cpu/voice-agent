/**
 * Frozen execution context — immutable snapshot for gate → tool → response.
 */
import type { SessionProductMemory } from "../memory/callMemoryStore.js";
import type { CallStateSlots } from "../memory/callStateStore.js";
import { buildProductSearchKey } from "../agents/productRetrievalPolicy.js";

export interface ExecutionContextSnapshot {
  readonly callSid: string;
  readonly frozenAt: number;
  readonly memory: Readonly<SessionProductMemory>;
  readonly slots: Readonly<CallStateSlots>;
  readonly searchKey: string | undefined;
  readonly explicitRepeat: boolean;
  readonly wantsRecommendations: boolean;
  executedSearchKey?: string;
  executedTool?: "searchProductByISBN" | "searchProductByTitle" | "getSimilarProducts";
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function freezeExecutionContext(input: {
  callSid: string;
  memory: SessionProductMemory;
  slots: CallStateSlots;
  explicitRepeat: boolean;
  wantsRecommendations?: boolean;
}): ExecutionContextSnapshot {
  const memory = deepClone(input.memory);
  const slots = deepClone(input.slots);
  const searchKey = buildProductSearchKey(memory);

  return Object.freeze({
    callSid: input.callSid,
    frozenAt: Date.now(),
    memory: Object.freeze(memory),
    slots: Object.freeze(slots),
    searchKey,
    explicitRepeat: input.explicitRepeat,
    wantsRecommendations: Boolean(input.wantsRecommendations),
  });
}

export function withExecutedSearch(
  snapshot: ExecutionContextSnapshot,
  executedSearchKey: string,
  executedTool: ExecutionContextSnapshot["executedTool"],
): ExecutionContextSnapshot {
  return Object.freeze({
    ...snapshot,
    executedSearchKey,
    executedTool,
  });
}
