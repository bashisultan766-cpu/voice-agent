/**
 * Sovereign turn router — non-tracking repeat intents only.
 * Tracking handshake, dictation, and spatial resume live in conversationOrchestrator.ts.
 */
import type { CallSession } from "../types/order.js";
import type { ActiveSession } from "./activeSession.js";
import {
  getOrCreateActiveSession,
  syncActiveSessionFromCallSession,
  updateActiveSession,
} from "./activeSession.js";
import { NOTEPAD_HANDSHAKE_PROMPT } from "../agents/conversationOrchestrator.js";

export interface SovereignTurnResolution {
  handled: boolean;
  speech?: string;
  skipLlm?: boolean;
  skipTools?: boolean;
  intentKey?: string;
}

export { NOTEPAD_HANDSHAKE_PROMPT };

const FULL_SUMMARY_RE = /\bfull\s+summary\b/i;

export function resolveSovereignTurn(
  callerText: string,
  callSession: CallSession,
): SovereignTurnResolution {
  const active = syncActiveSessionFromCallSession(callSession);
  const text = callerText.trim();
  if (!text) return { handled: false };

  if (
    active.cachedIntent &&
    active.lastSpokenPayload &&
    !FULL_SUMMARY_RE.test(text) &&
    /\b(repeat|say that again|what did you say)\b/i.test(text)
  ) {
    if (active.lastSpokenPayload.trackingForTts) {
      return { handled: false };
    }
    return {
      handled: true,
      speech: active.lastSpokenPayload.speech,
      skipLlm: true,
      skipTools: true,
      intentKey: active.cachedIntent,
    };
  }

  return { handled: false };
}

export function prepareActiveSessionForTurn(callSid: string): ActiveSession {
  return getOrCreateActiveSession(callSid);
}

export function markTrackingAwaitingNotepad(callSid: string): ActiveSession {
  return updateActiveSession(callSid, {
    currentState: "awaiting_notepad_ready",
    awaitingClarification: "notepad_ready",
    lastDictationIndex: -1,
    lastSpokenIndex: -1,
    isNotepadReady: false,
  });
}
