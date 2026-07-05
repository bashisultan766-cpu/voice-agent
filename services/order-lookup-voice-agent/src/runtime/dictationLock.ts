/**
 * Per-call dictation lock — suppresses barge-in / VAD interrupts during tracking ID readout.
 */
const dictationDepth = new Map<string, number>();

export function enterDictationLock(callSid: string): void {
  dictationDepth.set(callSid, (dictationDepth.get(callSid) ?? 0) + 1);
}

export function exitDictationLock(callSid: string): void {
  const next = (dictationDepth.get(callSid) ?? 0) - 1;
  if (next <= 0) {
    dictationDepth.delete(callSid);
  } else {
    dictationDepth.set(callSid, next);
  }
}

export function isDictationLocked(callSid: string): boolean {
  return (dictationDepth.get(callSid) ?? 0) > 0;
}

export function clearDictationLock(callSid: string): void {
  dictationDepth.delete(callSid);
}
