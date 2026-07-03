/**
 * Per-call lifecycle lock — prevents post-hangup event dispatch and turn processing.
 */

const activeCalls = new Set<string>();

/** Mark call as live (relay setup). */
export function markCallSessionActive(callSid: string): void {
  if (!callSid) return;
  activeCalls.add(callSid);
}

/** Lock session immediately on relay close — no further turns or events. */
export function markCallSessionClosed(callSid: string): void {
  if (!callSid) return;
  activeCalls.delete(callSid);
}

/** Whether the call may still ingest turns or dispatch agent events. */
export function isCallSessionActive(callSid: string): boolean {
  if (!callSid) return false;
  return activeCalls.has(callSid);
}

/** Test / teardown helper. */
export function clearCallSessionLock(callSid: string): void {
  activeCalls.delete(callSid);
}

export function clearAllCallSessionLocks(): void {
  activeCalls.clear();
}
