/**
 * Per-call AbortController for ConversationRelay turns.
 * Shared so OpenAI streaming / Shopify tools can halt on barge-in without circular imports.
 *
 * Generation counters invalidate in-flight tool results so a late Shopify response
 * cannot overwrite UnifiedCallSession after the caller interrupted.
 */
const activeTurnAborts = new Map<string, AbortController>();
const turnGenerations = new Map<string, number>();

function bumpGeneration(callSid: string): number {
  const next = (turnGenerations.get(callSid) ?? 0) + 1;
  turnGenerations.set(callSid, next);
  return next;
}

export function beginTurnAbort(callSid: string): AbortController {
  const existing = activeTurnAborts.get(callSid);
  if (existing && !existing.signal.aborted) {
    existing.abort();
  }
  bumpGeneration(callSid);
  const controller = new AbortController();
  activeTurnAborts.set(callSid, controller);
  return controller;
}

export function abortActiveTurn(callSid: string): void {
  bumpGeneration(callSid);
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

export function getTurnGeneration(callSid: string): number {
  return turnGenerations.get(callSid) ?? 0;
}

/** True when barge-in / a newer turn invalidated this tool's generation. */
export function isStaleTurnGeneration(callSid: string, generation: number): boolean {
  return getTurnGeneration(callSid) !== generation || isTurnAborted(callSid);
}

/** Test helper — reset registry state between cases. */
export function clearAllTurnAbortsForTests(): void {
  activeTurnAborts.clear();
  turnGenerations.clear();
}
