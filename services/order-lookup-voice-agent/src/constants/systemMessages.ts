/**
 * Canonical voice/system messages — single source for no-hallucination responses.
 */
export const EXACT_MATCH_NOT_FOUND_MESSAGE =
  "I could not find an exact match in the system.";

/** Spoken when semantic search returns close but non-exact title matches. */
export const SIMILAR_MATCHES_PREFIX =
  "I couldn't find the exact title, but I found these similar matches:";

export const ORDER_NOT_FOUND_MESSAGE =
  "I could not find an exact match in the system. Could you double-check the order number and try again?";

/** Spoken when Shopify order lookup returns zero matches — LLM must not paraphrase. */
export const ORDER_NOT_FOUND_STRICT_SPOKEN =
  "I apologize, but I cannot find an order matching that number in our system.";

/** Spoken when catalog/book tools return SYSTEM_MAINTENANCE — never mention API/token errors. */
export const SYSTEM_MAINTENANCE_SPOKEN =
  "I apologize, but our catalog system is currently undergoing a brief update. Is there anything else I can help you with today?";

/** LLM payload for catalog/book tool maintenance — never use for order lookup. */
export const SYSTEM_MAINTENANCE_LLM_PAYLOAD = {
  error: "SYSTEM_MAINTENANCE" as const,
  instructions:
    "Do not mention API keys or technical issues. Apologize to the user and state the catalog system is undergoing brief maintenance.",
};

/** Spoken when an order lookup hits a transient Shopify error — not the catalog. */
export const ORDER_LOOKUP_MAINTENANCE_SPOKEN =
  "I had a brief hiccup pulling that order. Let me try your order number again right now.";

/** Spoken when the caller insists the order number is correct after a miss. */
export const ORDER_LOOKUP_RETRY_SPOKEN =
  "You're right — let me look that order up again for you.";

/** LLM payload when order lookup hits a transient error — never use catalog maintenance wording. */
export const ORDER_LOOKUP_MAINTENANCE_LLM_PAYLOAD = {
  error: "ORDER_LOOKUP_RETRY" as const,
  instructions:
    "A transient order lookup error occurred. Say you are pulling the order up again now. Do NOT mention catalog updates or system maintenance. Do NOT invent order fields.",
};

/** Spoken when Shopify / tool execution hits the hard timeout ceiling. */
export const SHOPIFY_TIMEOUT_SPOKEN =
  "My system is running a bit slow right now, let's try that again in a moment.";

/** LLM payload when a tool times out — never invent Shopify data. */
export const SHOPIFY_TIMEOUT_LLM_PAYLOAD = {
  error: "Shopify API timeout" as const,
  status: "api_error" as const,
  instructions:
    'Do NOT invent order or catalog data. Say exactly: "My system is running a bit slow right now, let\'s try that again in a moment." Then wait for the caller.',
};

/** Lightweight ConversationRelay prompt when STT is empty or unintelligible. */
export const ARE_YOU_STILL_THERE_SPEECH = "Are you still there?";

/** Spoken when the voice WebSocket layer catches an unexpected turn error. */
export const VOICE_LAYER_ERROR_SPEECH =
  "Sorry, I hit a snag on that. If you're checking an order, please say your order number again and I'll pull it up right now.";

/** Spoken when Shopify catalog is throttled / circuit is open — buys backoff time. */
export const CATALOG_DEGRADED_MESSAGE =
  "Our catalog system is a bit slow right now. Let me check that again for you in just a second.";

/** Shorter retry prompt after backoff window. */
export const CATALOG_RETRY_MESSAGE =
  "Thanks for waiting. Let me try that catalog search one more time.";

/** @deprecated Use EXACT_MATCH_NOT_FOUND_MESSAGE */
export const STORE_NOT_FOUND_MESSAGE = EXACT_MATCH_NOT_FOUND_MESSAGE;

/** Spoken when an ISBN match exists in Shopify but is not available online. */
export const OUT_OF_STOCK_ISBN_MESSAGE =
  "This item is not currently available online. I can send your request to the warehouse team so they can check if it is available in storage.";
