/**
 * Canonical voice/system messages — single source for no-hallucination responses.
 */
export const EXACT_MATCH_NOT_FOUND_MESSAGE =
  "I could not find an exact match in the system.";

export const ORDER_NOT_FOUND_MESSAGE =
  "I could not find an exact match in the system. Could you double-check the order number and try again?";

/** Spoken when Shopify order lookup returns zero matches — LLM must not paraphrase. */
export const ORDER_NOT_FOUND_STRICT_SPOKEN =
  "I apologize, but I cannot find an order matching that number in our system.";

/** Spoken when catalog/book tools return SYSTEM_MAINTENANCE — never mention API/token errors. */
export const SYSTEM_MAINTENANCE_SPOKEN =
  "I apologize, but our catalog system is currently undergoing a brief update. Is there anything else I can help you with today?";

/** Spoken when an order lookup hits a transient Shopify error — not the catalog. */
export const ORDER_LOOKUP_MAINTENANCE_SPOKEN =
  "I had a brief hiccup pulling that order. Let me try your order number again right now.";

/** Spoken when the caller insists the order number is correct after a miss. */
export const ORDER_LOOKUP_RETRY_SPOKEN =
  "You're right — let me look that order up again for you.";

/** Spoken when Shopify catalog is throttled / circuit is open — buys backoff time. */
export const CATALOG_DEGRADED_MESSAGE =
  "Our catalog system is a bit slow right now. Let me check that again for you in just a second.";

/** Shorter retry prompt after backoff window. */
export const CATALOG_RETRY_MESSAGE =
  "Thanks for waiting. Let me try that catalog search one more time.";

/** @deprecated Use EXACT_MATCH_NOT_FOUND_MESSAGE */
export const STORE_NOT_FOUND_MESSAGE = EXACT_MATCH_NOT_FOUND_MESSAGE;
