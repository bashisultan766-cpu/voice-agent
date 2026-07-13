/**
 * Verification-first / conversational order lookup protocol — deterministic speech.
 */
import type { ParsedOrderData } from "../utils/orderDataParser.js";
import { fulfillmentStatusPhrase, speakMoney } from "../utils/formatter.js";
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
 * Human concierge summary after a successful deep order fetch.
 * Never just say "Order found."
 */
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

  const books = (data.lineItems ?? []).filter((item) => item.title?.trim());
  const bookPhrase =
    books.length === 0
      ? "your items"
      : books.length === 1
        ? books[0]!.title.trim()
        : books.length === 2
          ? `${books[0]!.title.trim()} and ${books[1]!.title.trim()}`
          : `${books[0]!.title.trim()} and ${books.length - 1} other books`;

  const total = data.totalAmount?.trim();
  const financial = (data.financialStatus ?? "").trim();
  const paidPhrase = data.isRefunded
    ? "the payment was refunded"
    : /paid|partially_paid/i.test(financial)
      ? "payment is marked paid"
      : financial
        ? `payment status is ${financial.toLowerCase().replace(/_/g, " ")}`
        : "payment was recorded";

  const notifyEmail =
    data.orderConfirmationEmail?.trim() ||
    data.customerEmail?.trim() ||
    data.refundNotificationEmail?.trim() ||
    "";

  const segments: string[] = [
    `I found your order ${orderId}. ${bookPhrase} ${books.length === 1 ? "is" : "are"} currently ${statusPhrase}.`,
    total
      ? `I can confirm ${paidPhrase} for ${speakMoney(total)}.`
      : `I can confirm ${paidPhrase}.`,
  ];

  if (notifyEmail) {
    segments.push(
      `All system notifications, shipping updates, and receipts were automatically routed to ${notifyEmail}.`,
    );
  }

  if (!data.cardLast4?.trim()) {
    segments.push(
      "Because this is a legacy order, the specific payment card details are hidden for security, but the transaction was successfully processed.",
    );
  }

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
