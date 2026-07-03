/**
 * Event store contract — append-only, ordered by turn_seq per callSid.
 */
import type { AgentEvent, StoredAgentEvent } from "./events.js";

export interface AppendEventInput {
  callSid: string;
  turnSeq: number;
  event: AgentEvent;
  memoryBefore?: StoredAgentEvent["memoryBefore"];
  memoryAfter?: StoredAgentEvent["memoryAfter"];
  latencyMs?: number;
}

export interface EventStore {
  append(input: AppendEventInput): StoredAgentEvent;
  loadSince(callSid: string, turnSeq: number): StoredAgentEvent[];
  clear(callSid: string): void;
  clearAll(): void;
}
