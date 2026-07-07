/**
 * Sovereign turn router — resolves turns from ActiveSession before tool/LLM calls.
 */
import type { CallSession } from "../types/order.js";
import type { ActiveSession } from "./activeSession.js";
import {
  buildSpatialResumeFromIndex,
  getOrCreateActiveSession,
  shouldSkipToolReinvoke,
  syncActiveSessionFromCallSession,
  updateActiveSession,
} from "./activeSession.js";
import {
  buildSpatialResumeSpeech,
  extractSpatialAnchorDigits,
  isSpatialResumeQuery,
} from "./spatialDictation.js";

export interface SovereignTurnResolution {
  handled: boolean;
  speech?: string;
  skipLlm?: boolean;
  skipTools?: boolean;
  intentKey?: string;
}

export const NOTEPAD_HANDSHAKE_PROMPT =
  "Please have your pen and notepad ready. Let me know when you are ready to note this down.";

const TRACKING_QUERY_RE =
  /\b(tracking|track(?:ing)?\s*(?:id|number)|where\s+is\s+my\s+package|read\s+(?:me\s+)?(?:the\s+)?tracking)\b/i;

const FULL_SUMMARY_RE = /\bfull\s+summary\b/i;

const NOTEPAD_READY_RE =
  /\b(ready|i'?m\s+ready|yes|ok|okay|go\s+ahead|all\s+set|you\s+can\s+go|note\s+it\s+down)\b/i;

const INTERRUPT_RESUME_RE =
  /\b(what\s+did\s+you\s+miss|missed\s+that|didn'?t\s+catch|repeat\s+from|continue\s+from|pick\s+up)\b/i;

function trackingPayloadReady(active: ActiveSession): boolean {
  return Boolean(active.lastSpokenPayload?.trackingForTts && active.spatialIndex.length > 0);
}

export function resolveSovereignTurn(
  callerText: string,
  callSession: CallSession,
): SovereignTurnResolution {
  const active = syncActiveSessionFromCallSession(callSession);
  const text = callerText.trim();
  if (!text) return { handled: false };

  if (active.currentState === "awaiting_notepad_ready" && trackingPayloadReady(active)) {
    if (NOTEPAD_READY_RE.test(text)) {
      updateActiveSession(callSession.callSid, {
        currentState: "tracking_dictation",
        awaitingClarification: null,
        lastDictationIndex: -1,
      });
      return {
        handled: true,
        speech: active.lastSpokenPayload!.trackingForTts!,
        skipLlm: true,
        skipTools: true,
        intentKey: "tracking_dictation",
      };
    }
    return {
      handled: true,
      speech: NOTEPAD_HANDSHAKE_PROMPT,
      skipLlm: true,
      skipTools: true,
      intentKey: "notepad_handshake",
    };
  }

  if (
    INTERRUPT_RESUME_RE.test(text) &&
    active.spatialIndex.length > 0 &&
    active.lastDictationIndex >= 0
  ) {
    const resume = buildSpatialResumeFromIndex(active.spatialIndex, active.lastDictationIndex);
    if (resume) {
      return {
        handled: true,
        speech: resume,
        skipLlm: true,
        skipTools: true,
        intentKey: "spatial_resume_interrupt",
      };
    }
  }

  if (isSpatialResumeQuery(text) && active.spatialIndex.length > 0) {
    const anchor = extractSpatialAnchorDigits(text);
    if (anchor) {
      const speech = buildSpatialResumeSpeech(
        active.spatialIndex,
        anchor,
        active.lastSpokenPayload?.trackingRaw,
      );
      if (speech) {
        return { handled: true, speech, skipLlm: true, skipTools: true, intentKey: "spatial_resume" };
      }
    }
  }

  if (TRACKING_QUERY_RE.test(text) && active.lastSpokenPayload?.trackingForTts) {
    if (
      shouldSkipToolReinvoke(active, "tracking", "get_shopify_order_status") ||
      active.currentState === "tracking_dictation" ||
      active.currentState === "awaiting_notepad_ready"
    ) {
      if (active.currentState !== "tracking_dictation") {
        updateActiveSession(callSession.callSid, {
          currentState: "awaiting_notepad_ready",
          awaitingClarification: "notepad_ready",
        });
        return {
          handled: true,
          speech: NOTEPAD_HANDSHAKE_PROMPT,
          skipLlm: true,
          skipTools: true,
          intentKey: "notepad_handshake",
        };
      }
      return {
        handled: true,
        speech: active.lastSpokenPayload.trackingForTts,
        skipLlm: true,
        skipTools: true,
        intentKey: "tracking",
      };
    }
  }

  if (
    active.cachedIntent &&
    active.lastSpokenPayload &&
    !FULL_SUMMARY_RE.test(text) &&
    /\b(repeat|say that again|what did you say)\b/i.test(text)
  ) {
    const replay =
      active.lastSpokenPayload.trackingForTts ?? active.lastSpokenPayload.speech;
    if (active.lastSpokenPayload.trackingForTts) {
      updateActiveSession(callSession.callSid, {
        currentState: "awaiting_notepad_ready",
        awaitingClarification: "notepad_ready",
      });
      return {
        handled: true,
        speech: NOTEPAD_HANDSHAKE_PROMPT,
        skipLlm: true,
        skipTools: true,
        intentKey: "notepad_handshake",
      };
    }
    return {
      handled: true,
      speech: replay,
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
  });
}
