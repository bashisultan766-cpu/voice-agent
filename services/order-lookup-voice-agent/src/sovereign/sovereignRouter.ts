/**
 * Sovereign turn router — resolves turns from ActiveSession before tool/LLM calls.
 */
import type { CallSession } from "../types/order.js";
import type { ActiveSession } from "./activeSession.js";
import {
  getOrCreateActiveSession,
  shouldSkipToolReinvoke,
  syncActiveSessionFromCallSession,
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

const TRACKING_QUERY_RE =
  /\b(tracking|track(?:ing)?\s*(?:id|number)|where\s+is\s+my\s+package)\b/i;

const FULL_SUMMARY_RE = /\bfull\s+summary\b/i;

export function resolveSovereignTurn(
  callerText: string,
  callSession: CallSession,
): SovereignTurnResolution {
  const active = syncActiveSessionFromCallSession(callSession);
  const text = callerText.trim();
  if (!text) return { handled: false };

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
      active.currentState === "tracking_dictation"
    ) {
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
