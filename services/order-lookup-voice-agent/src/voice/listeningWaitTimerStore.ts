/**
 * Process-local LISTENING_WAIT timer registry — no VoicePreTurn imports
 * (avoids circular deps between voicePreTurn and turnScheduler).
 */
export interface ArmedListeningWait {
  waitId: string;
  timer: NodeJS.Timeout;
}

const armedByCall = new Map<string, ArmedListeningWait>();

export function getArmedListeningWait(callSid: string): ArmedListeningWait | undefined {
  return armedByCall.get(callSid);
}

export function setArmedListeningWait(callSid: string, armed: ArmedListeningWait): void {
  armedByCall.set(callSid, armed);
}

export function deleteArmedListeningWait(callSid: string): ArmedListeningWait | undefined {
  const armed = armedByCall.get(callSid);
  armedByCall.delete(callSid);
  return armed;
}

export function clearArmedListeningWaitMap(): void {
  for (const armed of armedByCall.values()) {
    clearTimeout(armed.timer);
  }
  armedByCall.clear();
}

export function armedListeningWaitKeys(): string[] {
  return [...armedByCall.keys()];
}
