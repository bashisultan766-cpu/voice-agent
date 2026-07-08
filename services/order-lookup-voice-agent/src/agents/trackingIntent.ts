/**
 * Shared tracking-intent detection — orchestrator + LLM safety net use the same patterns.
 */
import { isSpatialResumeQuery } from "../sovereign/spatialDictation.js";

export const TRACKING_REQUEST_RE =
  /\b(?:tracking(?:\s*(?:id|number|#))?|track(?:ing)?\s*(?:id|number)|where\s+is\s+my\s+(?:package|shipment)|read\s+(?:me\s+)?(?:the\s+)?(?:tracking|track)|(?:give|tell|say|speak|repeat)\s+(?:me\s+)?(?:the\s+)?(?:tracking|track)|(?:what\s+is|what'?s)\s+(?:the\s+)?(?:tracking|track)|shipping\s+(?:tracking|number)|carrier\s+(?:number|tracking)|package\s+location)\b/i;

const TRACKING_SHORTHAND_RE =
  /\b(?:give|tell|read|say|speak|repeat)\s+(?:me\s+)?(?:the\s+)?(?:id|i\.?d\.?)\s*(?:number)?\b/i;

const TRACKING_ID_FRAGMENT_RE = /\btracking\s*i\.?d\.?\b/i;

const TRACKING_REPEAT_RE =
  /\b(?:didn'?t|did not|not yet|repeat|say (?:it )?again|one more time|can you repeat|read (?:it )?again|start over)\b/i;

export interface TrackingDictationContext {
  currentState?: string;
  lastSpokenIndex?: number;
  isNotepadReady?: boolean;
}

/** True when dictation has started (at least one digit spoken or actively dictating). */
export function hasTrackingDictationProgress(context?: TrackingDictationContext): boolean {
  if (!context) return true;
  if (context.isNotepadReady && context.currentState === "tracking_dictation") return true;
  if (context.currentState === "tracking_dictation" && (context.lastSpokenIndex ?? -1) >= 0) {
    return true;
  }
  return false;
}

/** Caller confirms they captured the tracking number — must NOT restart dictation. */
export function isTrackingDictationCompleteIntent(
  callerText: string,
  context?: TrackingDictationContext,
): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (isSpatialResumeQuery(text)) return false;
  if (TRACKING_REPEAT_RE.test(text)) return false;
  if (/\b(?:notepad|pen and paper|pen and notepad)\s+ready\b/i.test(text)) return false;
  if (/\b(?:i'?m|i am)\s+ready\b/i.test(text)) return false;

  const awaitingHandshake = context?.currentState === "awaiting_notepad_ready";

  if (
    /\b(?:written\s+(?:it\s+)?(?:down|correctly)|wrote\s+(?:it\s+)?down|got\s+it(?:\s+all)?|have\s+it(?:\s+all)?|copied\s+it|noted\s+(?:it|that)|finished\s+writing|done\s+writing)\b/i.test(
      text,
    )
  ) {
    if (awaitingHandshake) return false;
    return true;
  }

  if (/\b(?:thank\s+you|thanks(?:\s+(?:so\s+much|a\s+lot))?)\b/i.test(text)) {
    if (awaitingHandshake) return false;
    return hasTrackingDictationProgress(context);
  }

  if (/^(yes|yeah|yep|yup|correct|that'?s (?:right|correct)|perfect|ok|okay|sure)\.?!?$/i.test(text)) {
    if (awaitingHandshake) return false;
    return hasTrackingDictationProgress(context);
  }

  if (
    /\b(?:ok|okay|yes|yeah)\b/i.test(text) &&
    /\b(?:done|written|wrote|got it|have it|all set|all good)\b/i.test(text)
  ) {
    if (awaitingHandshake) return false;
    return hasTrackingDictationProgress(context);
  }

  return false;
}

export function isTrackingRequest(callerText: string): boolean {
  return isExplicitTrackingDictationRequest(callerText);
}

/** True only for explicit tracking-ID / package-location requests — not order status or customer name. */
export function isExplicitTrackingDictationRequest(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (isTrackingDictationCompleteIntent(text)) return false;
  if (isSpatialResumeQuery(text)) return false;
  if (TRACKING_REQUEST_RE.test(text)) return true;
  if (TRACKING_ID_FRAGMENT_RE.test(text)) return true;
  if (TRACKING_SHORTHAND_RE.test(text)) {
    if (/\btracking\b/i.test(text)) return true;
    if (/\b(?:carrier|package|shipment|parcel)\b/i.test(text)) return true;
    if (/\bid\s*number\b/i.test(text)) return true;
  }
  return false;
}

export function hasTrackingInSessionContext(
  currentOrderData?: Record<string, unknown>,
): boolean {
  const tracking = String(currentOrderData?.tracking_number ?? "").trim();
  return tracking.length > 0;
}
