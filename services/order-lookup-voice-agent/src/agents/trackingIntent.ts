/**
 * Shared tracking-intent detection — orchestrator + LLM safety net use the same patterns.
 */
import { isSpatialResumeQuery } from "../sovereign/spatialDictation.js";

export const TRACKING_REQUEST_RE =
  /\b(?:tracking(?:\s*(?:id|number|#))?|track(?:ing)?\s*(?:id|number)|where\s+is\s+my\s+(?:package|order|shipment)|read\s+(?:me\s+)?(?:the\s+)?(?:tracking|track)|(?:give|tell|say|speak|repeat)\s+(?:me\s+)?(?:the\s+)?(?:tracking|track)|(?:what\s+is|what'?s)\s+(?:the\s+)?(?:tracking|track)|shipping\s+(?:tracking|number)|carrier\s+(?:number|tracking))\b/i;

const TRACKING_SHORTHAND_RE =
  /\b(?:give|tell|read|say|speak|repeat)\s+(?:me\s+)?(?:the\s+)?(?:id|i\.?d\.?)\s*(?:number)?\b/i;

const TRACKING_ID_FRAGMENT_RE = /\btracking\s*i\.?d\.?\b/i;

const TRACKING_REPEAT_RE =
  /\b(?:didn'?t|did not|not yet|repeat|say (?:it )?again|one more time|can you repeat|read (?:it )?again|start over)\b/i;

/** Caller confirms they captured the tracking number — must NOT restart dictation. */
export function isTrackingDictationCompleteIntent(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (isSpatialResumeQuery(text)) return false;
  if (TRACKING_REPEAT_RE.test(text)) return false;
  if (/\b(?:notepad|pen and paper|pen and notepad)\s+ready\b/i.test(text)) return false;
  if (/\b(?:i'?m|i am)\s+ready\b/i.test(text)) return false;

  if (
    /\b(?:written\s+(?:it\s+)?(?:down|correctly)|wrote\s+(?:it\s+)?down|got\s+it(?:\s+all)?|have\s+it(?:\s+all)?|copied\s+it|noted\s+(?:it|that)|finished\s+writing|done\s+writing)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  if (/\b(?:thank\s+you|thanks(?:\s+(?:so\s+much|a\s+lot))?)\b/i.test(text)) {
    return true;
  }

  if (/^(yes|yeah|yep|yup|correct|that'?s (?:right|correct)|perfect|ok|okay|sure)\.?!?$/i.test(text)) {
    return true;
  }

  if (
    /\b(?:ok|okay|yes|yeah)\b/i.test(text) &&
    /\b(?:done|written|wrote|got it|have it|all set|all good)\b/i.test(text)
  ) {
    return true;
  }

  return false;
}

export function isTrackingRequest(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (isTrackingDictationCompleteIntent(text)) return false;
  if (isSpatialResumeQuery(text)) return false;
  if (TRACKING_REQUEST_RE.test(text)) return true;
  if (TRACKING_ID_FRAGMENT_RE.test(text)) return true;
  if (TRACKING_SHORTHAND_RE.test(text)) return true;
  return false;
}

export function hasTrackingInSessionContext(
  currentOrderData?: Record<string, unknown>,
): boolean {
  const tracking = String(currentOrderData?.tracking_number ?? "").trim();
  return tracking.length > 0;
}
