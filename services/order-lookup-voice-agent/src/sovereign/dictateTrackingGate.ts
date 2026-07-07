/**
 * Notepad gate for tracking dictation — sole entry for dictate_tracking speech.
 */
import {
  getOrCreateActiveSession,
  updateActiveSession,
} from "./activeSession.js";
import { NOTEPAD_HANDSHAKE_PROMPT } from "../agents/conversationOrchestrator.js";

export type DictateTrackingIntent = "ReadinessRequest" | "dictate_tracking" | "unavailable";

export interface DictateTrackingResolution {
  intent: DictateTrackingIntent;
  speech: string;
}

export function resolveDictateTracking(callSid: string): DictateTrackingResolution {
  const active = getOrCreateActiveSession(callSid);
  const trackingForTts = active.lastSpokenPayload?.trackingForTts?.trim();

  if (!trackingForTts) {
    return {
      intent: "unavailable",
      speech: "I do not have a tracking number on file yet. Would you like me to look up your order?",
    };
  }

  if (!active.isNotepadReady) {
    return {
      intent: "ReadinessRequest",
      speech: NOTEPAD_HANDSHAKE_PROMPT,
    };
  }

  updateActiveSession(callSid, {
    currentState: "tracking_dictation",
    awaitingClarification: null,
    lastDictationIndex: -1,
  });

  return {
    intent: "dictate_tracking",
    speech: trackingForTts,
  };
}
