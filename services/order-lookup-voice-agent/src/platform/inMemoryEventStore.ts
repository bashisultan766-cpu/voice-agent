/**
 * In-process append-only event log — Phase 1 capture alongside legacy Map stores.
 */
import { agentEventSchema, type StoredAgentEvent } from "./events.js";
import type { AppendEventInput, EventStore } from "./eventStore.js";

const EVENT_VERSION = 1;

interface CallEventLog {
  events: StoredAgentEvent[];
  nextId: number;
}

const logs = new Map<string, CallEventLog>();

function getLog(callSid: string): CallEventLog {
  let log = logs.get(callSid);
  if (!log) {
    log = { events: [], nextId: 1 };
    logs.set(callSid, log);
  }
  return log;
}

export class InMemoryEventStore implements EventStore {
  append(input: AppendEventInput): StoredAgentEvent {
    agentEventSchema.parse(input.event);

    const log = getLog(input.callSid);
    const stored: StoredAgentEvent = {
      id: `${input.callSid}:${log.nextId}`,
      callSid: input.callSid,
      turnSeq: input.turnSeq,
      eventType: input.event.type,
      eventVersion: EVENT_VERSION,
      payload: input.event.payload,
      memoryBefore: input.memoryBefore ?? null,
      memoryAfter: input.memoryAfter ?? null,
      latencyMs: input.latencyMs ?? null,
      createdAt: Date.now(),
    };

    log.nextId += 1;
    log.events.push(stored);
    return stored;
  }

  loadSince(callSid: string, turnSeq: number): StoredAgentEvent[] {
    const log = logs.get(callSid);
    if (!log) return [];
    return log.events.filter((event) => event.turnSeq >= turnSeq);
  }

  clear(callSid: string): void {
    logs.delete(callSid);
  }

  clearAll(): void {
    logs.clear();
  }
}

/** Singleton used by the runtime dispatcher (Phase 1). */
export const inMemoryEventStore = new InMemoryEventStore();
