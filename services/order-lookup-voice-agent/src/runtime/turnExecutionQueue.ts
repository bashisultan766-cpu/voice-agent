/**
 * Per-call turn queue — one active turn at a time; prevents STT/LLM/tool races.
 */
import { logger } from "../utils/logger.js";

interface TurnQueueState {
  tail: Promise<void>;
  active: boolean;
  queued: number;
  completed: number;
}

const queues = new Map<string, TurnQueueState>();

function getQueue(callSid: string): TurnQueueState {
  let state = queues.get(callSid);
  if (!state) {
    state = { tail: Promise.resolve(), active: false, queued: 0, completed: 0 };
    queues.set(callSid, state);
  }
  return state;
}

export interface TurnQueueSnapshot {
  callSid: string;
  active: boolean;
  queued: number;
  completed: number;
}

export function getTurnQueueSnapshot(callSid: string): TurnQueueSnapshot {
  const state = getQueue(callSid);
  return {
    callSid: callSid.slice(0, 8),
    active: state.active,
    queued: state.queued,
    completed: state.completed,
  };
}

export function logTurnQueueState(callSid: string, event: string): void {
  const snap = getTurnQueueSnapshot(callSid);
  logger.info("turn_queue_state", { event, ...snap });
}

/** Acquire exclusive turn lock for callSid. Resolves with release function. */
export async function acquireTurnLock(callSid: string): Promise<() => void> {
  const state = getQueue(callSid);
  state.queued += 1;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      state.active = false;
      state.completed += 1;
      state.queued = Math.max(0, state.queued - 1);
      logTurnQueueState(callSid, "released");
      resolve();
    };
  });

  const previous = state.tail;
  state.tail = previous.then(async () => {
    await previous;
    state.active = true;
    logTurnQueueState(callSid, "acquired");
    await gate;
  });

  await previous;
  return release;
}

/** Run async work exclusively for this callSid. */
export async function runExclusiveTurn<T>(callSid: string, work: () => Promise<T>): Promise<T> {
  const release = await acquireTurnLock(callSid);
  try {
    return await work();
  } finally {
    release();
  }
}

export function clearTurnQueue(callSid: string): void {
  queues.delete(callSid);
}

export function clearAllTurnQueues(): void {
  queues.clear();
}
