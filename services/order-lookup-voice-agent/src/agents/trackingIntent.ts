/**
 * Shared tracking-intent detection — orchestrator + LLM safety net use the same patterns.
 */
import { isSpatialResumeQuery } from "../sovereign/spatialDictation.js";

export const TRACKING_REQUEST_RE =
  /\b(?:tracking(?:\s*(?:id|number|#))?|track(?:ing)?\s*(?:id|number)|where\s+is\s+my\s+(?:package|order|shipment)|read\s+(?:me\s+)?(?:the\s+)?(?:tracking|track)|(?:give|tell|say|speak|repeat)\s+(?:me\s+)?(?:the\s+)?(?:tracking|track)|(?:what\s+is|what'?s)\s+(?:the\s+)?(?:tracking|track)|shipping\s+(?:tracking|number)|carrier\s+(?:number|tracking))\b/i;

const TRACKING_SHORTHAND_RE =
  /\b(?:give|tell|read|say|speak|repeat)\s+(?:me\s+)?(?:the\s+)?(?:id|i\.?d\.?)\s*(?:number)?\b/i;

const TRACKING_ID_FRAGMENT_RE = /\btracking\s*i\.?d\.?\b/i;

export function isTrackingRequest(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
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
