/**

 * Event dispatcher — single write path for Phase 2 event-sourced state.

 *

 * Flow: validate event → append to event log → fold reducer → project to legacy stores.

 * Postgres dual-write remains fire-and-forget (never blocks voice path).

 */

import { isCompleteIsbnValue } from "../utils/productSearchNormalize.js";

import { logger } from "../utils/logger.js";

import {

  type AgentEvent,

  type CallSnapshot,

  snapshotFromMemory,

} from "./events.js";

import type { StoredAgentEvent } from "./events.js";

import { inMemoryEventStore } from "./inMemoryEventStore.js";

import { appendToPostgresAsync } from "./postgresEventStore.js";

import { agentStateReducer } from "./reducers.js";

import {

  captureProjectionSnapshot,

  clearAgentState,

  clearAllAgentStates,

  getAgentState,

  setAgentState,

} from "./stateProjection.js";

import { getOrCreateMemory } from "../memory/callMemoryStore.js";

import { getOrCreateCallState } from "../memory/callStateStore.js";

import { isCallSessionActive, clearAllCallSessionLocks } from "../voice/callSessionLock.js";



const turnSeqByCall = new Map<string, number>();



/** Begin a new user turn — increments monotonic turn_seq for all events in this turn. */

export function beginCallTurn(callSid: string): number {

  const next = (turnSeqByCall.get(callSid) ?? 0) + 1;

  turnSeqByCall.set(callSid, next);

  return next;

}



export function currentCallTurnSeq(callSid: string): number {

  return turnSeqByCall.get(callSid) ?? 0;

}



/** Capture authoritative session + call-state for JSONB memory_before / memory_after. */

export function captureCallSnapshot(callSid: string): CallSnapshot {

  return captureProjectionSnapshot(callSid);

}



/** Legacy snapshot from stores — used when projection not yet initialized. */

export function captureCallSnapshotFromStores(callSid: string): CallSnapshot {

  const memory = getOrCreateMemory(callSid);

  const state = getOrCreateCallState(callSid);

  return snapshotFromMemory(memory.product, state, memory.lastOrderNumber);

}



/**

 * Defensive: partial ISBN accumulator must clear when a complete ISBN lands in memory.

 * Used in MEMORY_SYNCD payload for replay auditors.

 */

export function detectIsbnPartialCleared(before: CallSnapshot, after: CallSnapshot): boolean {

  const priorSlot = before.callState.slots.isbn;

  const priorProduct = before.product.isbn;

  const hadPartial =

    Boolean(priorSlot && !isCompleteIsbnValue(priorSlot)) ||

    Boolean(priorProduct && !isCompleteIsbnValue(priorProduct));



  const nextIsbn = after.product.isbn ?? after.callState.slots.isbn;

  return hadPartial && Boolean(nextIsbn && isCompleteIsbnValue(nextIsbn));

}



/**

 * Append validated event → apply pure reducer → project to stores → async Postgres.

 * Synchronous return — Postgres never blocks the voice hot path.

 */

export function dispatchAgentEvent(

  callSid: string,

  event: AgentEvent,

  options: {

    memoryBefore?: CallSnapshot | null;

    memoryAfter?: CallSnapshot | null;

    latencyMs?: number;

    turnSeq?: number;

    skipReducer?: boolean;

  } = {},

): StoredAgentEvent | null {

  if (!isCallSessionActive(callSid)) {
    return null;
  }

  const turnSeq = options.turnSeq ?? currentCallTurnSeq(callSid);

  if (turnSeq === 0) {

    logger.warn("dispatch_without_turn_seq", {

      callSid: callSid.slice(0, 8),

      eventType: event.type,

    });

  }



  const memoryBefore = options.memoryBefore ?? captureCallSnapshot(callSid);



  const stored = inMemoryEventStore.append({

    callSid,

    turnSeq,

    event,

    memoryBefore,

    memoryAfter: null,

    latencyMs: options.latencyMs,

  });



  if (!options.skipReducer) {

    const prior = getAgentState(callSid);

    const next = agentStateReducer(

      { ...prior, turnSeq: event.type === "TURN_INGESTED" ? turnSeq : prior.turnSeq || turnSeq },

      event,

    );

    const syncedTurnSeq = event.type === "TURN_INGESTED" ? turnSeq : next.turnSeq || turnSeq;

    setAgentState(callSid, { ...next, turnSeq: syncedTurnSeq });

  }



  const memoryAfter = options.memoryAfter ?? captureCallSnapshot(callSid);

  stored.memoryAfter = memoryAfter;



  logger.debug("agent_event_dispatched", {

    callSid: callSid.slice(0, 8),

    turnSeq,

    eventType: event.type,

    eventId: stored.id,

  });



  appendToPostgresAsync({ ...stored, memoryAfter });

  return stored;

}



export function loadCallEventsSince(callSid: string, turnSeq: number): StoredAgentEvent[] {

  return inMemoryEventStore.loadSince(callSid, turnSeq);

}



export function clearCallEventSession(callSid: string): void {

  inMemoryEventStore.clear(callSid);

  turnSeqByCall.delete(callSid);

  clearAgentState(callSid);

}



export function clearAllCallEventSessions(): void {

  inMemoryEventStore.clearAll();

  turnSeqByCall.clear();

  clearAllAgentStates();

  clearAllCallSessionLocks();

}



export { getAgentState } from "./stateProjection.js";


