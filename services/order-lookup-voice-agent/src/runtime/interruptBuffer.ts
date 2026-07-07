/**
 * Per-call interrupt buffer — set when caller speech is detected during agent TTS.
 */
const buffers = new Map<string, string>();

export function pushInterruptSignal(callSid: string, transcript = ""): void {
  const existing = buffers.get(callSid) ?? "";
  buffers.set(callSid, existing ? `${existing} ${transcript}`.trim() : transcript.trim());
}

export function isInterruptBufferFull(callSid: string): boolean {
  return buffers.has(callSid);
}

export function takeInterruptSignal(callSid: string): string {
  const value = buffers.get(callSid) ?? "";
  buffers.delete(callSid);
  return value;
}

export function clearInterruptBuffer(callSid: string): void {
  buffers.delete(callSid);
}
