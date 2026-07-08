/**
 * Shared tracking-intent detection — orchestrator + LLM safety net use the same patterns.
 */
export const TRACKING_REQUEST_RE =
  /\b(?:tracking(?:\s*(?:id|number|#))?|track(?:ing)?\s*(?:id|number)|where\s+is\s+my\s+(?:package|order|shipment)|read\s+(?:me\s+)?(?:the\s+)?(?:tracking|track)|(?:give|tell|say|speak|repeat)\s+(?:me\s+)?(?:the\s+)?(?:tracking|track)|(?:what\s+is|what'?s)\s+(?:the\s+)?(?:tracking|track)|shipping\s+(?:tracking|number)|carrier\s+(?:number|tracking))\b/i;

export function isTrackingRequest(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  return TRACKING_REQUEST_RE.test(text);
}
