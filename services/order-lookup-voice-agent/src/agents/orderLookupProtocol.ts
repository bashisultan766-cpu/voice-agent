/**
 * Verification-first order lookup protocol — passive confirmation until asked.
 */
import type { ParsedOrderData } from "../utils/orderDataParser.js";
import type { CallSession } from "../types/order.js";
import { callerAskedForTracking } from "./sessionMemory.js";
import { hasConfirmedOrderContext } from "./orderContextPolicy.js";

export const ORDER_NUMBER_PREFLIGHT_SPEECH =
  "I can look that up for you. Please tell me your order number first.";

export const TRACKING_ORDER_NUMBER_PREFLIGHT_SPEECH =
  "I can help you with your tracking ID. Please tell me your order number first.";

/** Hard stop — after this many failed order-number captures, stop re-asking. */
export const MAX_ORDER_NUMBER_ATTEMPTS = 3;

/** Injected into the next LLM turn when order-number capture is exhausted. */
export const ORDER_NUMBER_ATTEMPTS_EXHAUSTED_SYSTEM_NOTE =
  "[SYSTEM: Order number failed 3 times. Apologize and ask if they want to search by title or speak to support. Do not ask for the order number again unless they volunteer digits.]";

export const TRACKING_ID_OFFER_SPEECH = "Would you like me to read the tracking ID?";

export const POST_INFORMATION_CLOSING_SPEECH =
  "I have provided that, how else can I help you today?";

/**
 * Passive confirmation after a successful deep order fetch.
 * Never auto-read status, items, totals, or emails — wait for a specific question.
 */
export const ORDER_FOUND_PASSIVE_SPEECH =
  "I've found your order. How can I help you with this one?";

/** ORDER_LOOKUP / tracking goals must not hit Shopify until an order number is collected. */
export function requiresOrderNumberPreflight(
  intent: string,
  options: {
    hasOrderNumberInUtterance: boolean;
    hasConfirmedContext: boolean;
    awaitingOrderNumber?: boolean;
    wantsTracking?: boolean;
  },
): boolean {
  if (options.hasConfirmedContext) return false;
  if (options.hasOrderNumberInUtterance) return false;
  if (
    intent === "order_lookup" ||
    intent === "order_status" ||
    intent === "tracking_dictation" ||
    intent === "tracking_id" ||
    options.wantsTracking
  ) {
    return true;
  }
  return false;
}

export function buildOrderNumberPreflightSpeech(session?: CallSession): string {
  if (session && callerAskedForTracking(session)) {
    return TRACKING_ORDER_NUMBER_PREFLIGHT_SPEECH;
  }
  return ORDER_NUMBER_PREFLIGHT_SPEECH;
}

/**
 * Confirmation & Ready — passive until the caller asks for a specific field.
 * Full deep-fetch data stays in session/LLM memory for follow-ups.
 */
export function buildVerificationFirstOrderSpeech(
  _data: ParsedOrderData,
  session?: CallSession,
): string {
  void _data;
  // If they asked for tracking up front, arm the offer path without dumping order details.
  if (session && callerAskedForTracking(session)) {
    return `${ORDER_FOUND_PASSIVE_SPEECH} ${TRACKING_ID_OFFER_SPEECH}`;
  }
  return ORDER_FOUND_PASSIVE_SPEECH;
}

/** Arm tracking-offer acceptance when disclosure speech includes the read-tracking prompt. */
export function syncTrackingOfferState(speech: string, session: CallSession): void {
  if (speech.includes(TRACKING_ID_OFFER_SPEECH)) {
    session.awaitingTrackingOffer = true;
  }
}

export function appendProtocolClosing(speech: string): string {
  const trimmed = speech.trim();
  if (!trimmed) return POST_INFORMATION_CLOSING_SPEECH;
  if (trimmed.includes(POST_INFORMATION_CLOSING_SPEECH)) return trimmed;
  return `${trimmed} ${POST_INFORMATION_CLOSING_SPEECH}`;
}

export function shouldSkipOrderNumberReask(session: CallSession): boolean {
  return hasConfirmedOrderContext(session);
}
