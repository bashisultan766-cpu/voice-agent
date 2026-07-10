/**
 * Per-call AbortController for ConversationRelay turns.
 * Shared so OpenAI streaming can halt on barge-in without circular imports.
 */
const activeTurnAborts = new Map<string, AbortController>();

export function beginTurnAbort(callSid: string): AbortController {
  const existing = activeTurnAborts.get(callSid);
  if (existing && !existing.signal.aborted) {
    existing.abort();
  }
  const controller = new AbortController();
  activeTurnAborts.set(callSid, controller);
  return controller;
}

export function abortActiveTurn(callSid: string): void {
  const controller = activeTurnAborts.get(callSid);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  activeTurnAborts.delete(callSid);
}

export function clearTurnAbort(callSid: string): void {
  activeTurnAborts.delete(callSid);
}

export function getTurnAbortSignal(callSid: string): AbortSignal | undefined {
  return activeTurnAborts.get(callSid)?.signal;
}

export function isTurnAborted(callSid: string): boolean {
  return activeTurnAborts.get(callSid)?.signal.aborted === true;
}
