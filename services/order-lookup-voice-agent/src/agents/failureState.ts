/**
 * FAILURE_STATE — no dual/fallback paths. Tool failures must be acknowledged
 * before the same operation is retried (atomic commerce principle).
 */
import type { CallSession } from "../types/order.js";
import { ensureSessionMemory } from "./sessionMemory.js";

export interface FailureStateRecord {
  code: string;
  message: string;
  tool?: string;
  recordedAt: number;
}

/** Record a FAILURE_STATE — blocks retry of payment/checkout until acknowledged. */
export function recordFailureState(
  session: CallSession,
  code: string,
  message: string,
  tool?: string,
): FailureStateRecord {
  const memory = ensureSessionMemory(session);
  const record: FailureStateRecord = {
    code,
    message,
    tool,
    recordedAt: Date.now(),
  };
  memory.lastFailureState = record;
  memory.failureAcknowledged = false;
  return record;
}

/** Caller acknowledged the failure (apology spoken / they said ok) — allow retry. */
export function acknowledgeFailureState(session: CallSession): void {
  const memory = ensureSessionMemory(session);
  if (memory.lastFailureState) {
    memory.failureAcknowledged = true;
  }
}

export function clearFailureState(session: CallSession): void {
  const memory = ensureSessionMemory(session);
  memory.lastFailureState = undefined;
  memory.failureAcknowledged = undefined;
}

export function hasUnacknowledgedFailure(session: CallSession): boolean {
  const memory = ensureSessionMemory(session);
  return Boolean(memory.lastFailureState && !memory.failureAcknowledged);
}

/** Spoken FAILURE_STATE ack the agent must deliver before retrying. */
export function buildFailureStateSpeech(session: CallSession): string | null {
  const memory = ensureSessionMemory(session);
  const fail = memory.lastFailureState;
  if (!fail || memory.failureAcknowledged) return null;

  // QA path for email_unknown: clear forward offer after reconcile (no cart re-plan).
  const reconcile = memory.emailUnknownReconcile;
  if (
    reconcile &&
    (fail.code === "EMAIL_DELIVERY_UNKNOWN" ||
      fail.code === "CHECKOUT_EXCEPTION" ||
      /email|invoice|checkout|payment\s*link/i.test(fail.message))
  ) {
    return reconcile.invoicePending
      ? "I've checked the status and the invoice is still pending. I can send it again if you'd like."
      : "I've checked the status and we still need to finish sending your payment link. I can try again if you'd like — just say send it again.";
  }

  return (
    `I'm sorry — that step didn't go through. ${fail.message} ` +
    `Please confirm you've heard that, and we can try again when you're ready.`
  );
}

/**
 * Detect caller acknowledging a prior failure so retry is allowed.
 * Softens retry: "send it again" / "retry one more time" count without explicit Yes/Okay.
 */
export function maybeAcknowledgeFailureFromUtterance(
  session: CallSession,
  text: string,
): boolean {
  if (!hasUnacknowledgedFailure(session)) return false;
  const t = (text ?? "").trim();
  if (
    /\b(yes|yeah|yep|ok|okay|understood|got it|i hear you|acknowledge|try again|retry|go ahead)\b/i.test(
      t,
    ) ||
    /\b(send\s+it\s+again|send\s+again|resend|re-?send|retry\s+one\s+more\s+time|one\s+more\s+time|try\s+one\s+more\s+time)\b/i.test(
      t,
    )
  ) {
    acknowledgeFailureState(session);
    return true;
  }
  return false;
}

export const FailureState = {
  record: recordFailureState,
  acknowledge: acknowledgeFailureState,
  clear: clearFailureState,
  hasUnacknowledged: hasUnacknowledgedFailure,
  buildSpeech: buildFailureStateSpeech,
  maybeAcknowledgeFromUtterance: maybeAcknowledgeFailureFromUtterance,
} as const;
