/**
 * SessionMemory — preserves the caller's initial goal across the whole call.
 * Never drops a stated intent (e.g. tracking ID) after order number collection or lookup.
 */
import type { CallSession } from "../types/order.js";
import { TRACKING_REQUEST_RE } from "./trackingIntent.js";

export type BufferedSessionIntent =
  | "order_lookup"
  | "tracking_id"
  | "order_status"
  | "general";

export interface SessionMemoryState {
  initialIntent: BufferedSessionIntent | null;
  pendingGoal: BufferedSessionIntent | null;
}

const EMPTY: SessionMemoryState = { initialIntent: null, pendingGoal: null };

function ensureMemory(session: CallSession): SessionMemoryState {
  if (!session.sessionMemory) {
    session.sessionMemory = { ...EMPTY };
  }
  return session.sessionMemory;
}

export function getSessionMemory(session: CallSession): SessionMemoryState {
  return session.sessionMemory ?? EMPTY;
}

/** Infer buffered intent from utterance before tools run. */
export function inferBufferedIntentFromSpeech(
  text: string,
  classifiedIntent?: string,
): BufferedSessionIntent | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  if (TRACKING_REQUEST_RE.test(trimmed) || /\btracking\s*i\.?d\.?\b/i.test(trimmed)) {
    return "tracking_id";
  }
  if (
    classifiedIntent === "order_lookup" ||
    /\b(order\s+status|where\s+is\s+my\s+order|track\s+my\s+order|my\s+order)\b/i.test(trimmed)
  ) {
    return "order_lookup";
  }
  if (classifiedIntent === "product_search" || classifiedIntent === "isbn_query") {
    return null;
  }
  return null;
}

/**
 * Capture the caller's first stated goal — only set once per call unless pendingGoal was cleared.
 */
export function captureSessionIntent(
  session: CallSession,
  text: string,
  classifiedIntent?: string,
): SessionMemoryState {
  const memory = ensureMemory(session);
  const inferred = inferBufferedIntentFromSpeech(text, classifiedIntent);
  if (!inferred) return memory;

  if (!memory.initialIntent) {
    memory.initialIntent = inferred;
  }
  if (!memory.pendingGoal) {
    memory.pendingGoal = inferred;
  }
  return memory;
}

export function markSessionGoalFulfilled(
  session: CallSession,
  goal: BufferedSessionIntent,
): void {
  const memory = ensureMemory(session);
  if (memory.pendingGoal === goal) {
    memory.pendingGoal = null;
  }
}

export function callerAskedForTracking(session: CallSession): boolean {
  const memory = getSessionMemory(session);
  return memory.initialIntent === "tracking_id" || memory.pendingGoal === "tracking_id";
}

export function clearSessionMemory(session: CallSession): void {
  session.sessionMemory = { ...EMPTY };
}
