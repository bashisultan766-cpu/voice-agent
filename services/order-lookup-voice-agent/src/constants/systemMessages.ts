/**
 * Canonical voice/system messages — single source for no-hallucination responses.
 */
export const EXACT_MATCH_NOT_FOUND_MESSAGE =
  "I could not find an exact match in the system.";

export const ORDER_NOT_FOUND_MESSAGE =
  "I could not find an exact match in the system. Could you double-check the order number and try again?";

/** Spoken when Shopify catalog is throttled / circuit is open — buys backoff time. */
export const CATALOG_DEGRADED_MESSAGE =
  "Our catalog system is a bit slow right now. Let me check that again for you in just a second.";

/** Shorter retry prompt after backoff window. */
export const CATALOG_RETRY_MESSAGE =
  "Thanks for waiting. Let me try that catalog search one more time.";

/** @deprecated Use EXACT_MATCH_NOT_FOUND_MESSAGE */
export const STORE_NOT_FOUND_MESSAGE = EXACT_MATCH_NOT_FOUND_MESSAGE;
