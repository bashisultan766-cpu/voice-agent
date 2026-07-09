/**
 * Verification-first order lookup protocol — deterministic speech, no LLM choice.
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

export const TRACKING_ID_OFFER_SPEECH = "Would you like me to read the tracking ID?";

export const POST_INFORMATION_CLOSING_SPEECH =
  "I have provided that, how else can I help you today?";

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

export function buildVerificationFirstOrderSpeech(
  data: ParsedOrderData,
  session?: CallSession,
): string {
  const orderId = data.orderNumber?.replace(/^#/, "") ?? "unknown";

  let statusPhrase: string;
  if (data.isRefunded) {
    statusPhrase = "Refunded";
  } else if (data.fulfillmentStatus?.trim()) {
    statusPhrase = fulfillmentStatusPhrase(data.fulfillmentStatus);
  } else {
    statusPhrase = "being processed";
  }

  const placedOn =
    data.orderPlacedAtSpoken?.trim() ||
    data.orderPlacedAt?.trim() ||
    "the date on file";

  const segments: string[] = [
    `I have found your order ${orderId}. It was placed on ${placedOn} and the status is ${statusPhrase}.`,
  ];

  const askedForTracking = Boolean(session && callerAskedForTracking(session));
  if (askedForTracking && !data.trackingNumber?.trim()) {
    segments.push(
      "I do not have a valid tracking number on file yet. It may not have shipped, or it may have been refunded.",
    );
  } else if (askedForTracking && data.trackingNumber?.trim()) {
    segments.push(TRACKING_ID_OFFER_SPEECH);
  }

  segments.push(POST_INFORMATION_CLOSING_SPEECH);
  return segments.join(" ");
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

export function orderLookupMayAccessDatabase(session: CallSession): boolean {
  return hasConfirmedOrderContext(session);
}
