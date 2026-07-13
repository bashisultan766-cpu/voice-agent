/**
 * Verification-first order lookup protocol — Concierge Gateway until asked.
 */
import type { ParsedOrderData } from "../utils/orderDataParser.js";
import { fulfillmentStatusPhrase } from "../utils/formatter.js";
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

export const ORDER_FOUND_FOLLOW_UP =
  "How can I assist you further with this order?";

/**
 * Concierge Gateway — status only after successful lookup.
 * Never auto-read tracking, address, or items.
 */
export function buildOrderFoundGatewaySpeech(data: {
  orderNumber?: string;
  customerName?: string;
  fulfillmentStatus?: string;
  financialStatus?: string;
}): string {
  const orderNumber =
    String(data.orderNumber ?? "")
      .replace(/^#/, "")
      .trim() || "unknown";
  const customerName = data.customerName?.trim() || "the customer";
  const statusRaw =
    data.fulfillmentStatus?.trim() || data.financialStatus?.trim() || "unknown";
  const status = fulfillmentStatusPhrase(statusRaw);
  return (
    `I have successfully pulled up order ${orderNumber} for ${customerName}. ` +
    `Order status is ${status}. ${ORDER_FOUND_FOLLOW_UP}`
  );
}

/** @deprecated Use buildOrderFoundGatewaySpeech — kept for re-exports / tests expecting a constant name. */
export const ORDER_FOUND_PASSIVE_SPEECH =
  "I have successfully pulled up order [Number] for [Customer Name]. Order status is [Status]. How can I assist you further with this order?";

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
 * Confirmation & Ready — Concierge Gateway only (status + follow-up).
 * Full deep-fetch data stays in session/LLM memory for follow-ups.
 */
export function buildVerificationFirstOrderSpeech(
  data: ParsedOrderData,
  _session?: CallSession,
): string {
  void _session;
  return buildOrderFoundGatewaySpeech(data);
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
