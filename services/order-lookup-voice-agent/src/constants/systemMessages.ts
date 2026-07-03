/**
 * Canonical voice/system messages — single source for no-hallucination responses.
 */
export const EXACT_MATCH_NOT_FOUND_MESSAGE =
  "I could not find an exact match in the system.";

export const ORDER_NOT_FOUND_MESSAGE =
  "I could not find an exact match in the system. Could you double-check the order number and try again?";

/** @deprecated Use EXACT_MATCH_NOT_FOUND_MESSAGE */
export const STORE_NOT_FOUND_MESSAGE = EXACT_MATCH_NOT_FOUND_MESSAGE;
