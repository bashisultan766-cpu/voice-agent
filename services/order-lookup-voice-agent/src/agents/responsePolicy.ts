/**
 * Central response policy — verified vs non-verified field disclosure.
 * Single source for deterministic refusals and vault field authorization.
 */
import type { CallSession } from "../types/order.js";
import {
  canRevealOrderField,
  disclosureTierForSession,
  type DisclosureTier,
  type OrderRevealField,
} from "./verificationGate.js";
import { buildUnverifiedRestrictedFieldRefusal } from "./orderContextPrivacy.js";

export type OrderDisclosureField =
  | "shipping_address"
  | "order_history"
  | "full_order_details"
  | "line_items"
  | "total_amount"
  | "shipping_amount"
  | "payment_method"
  | "card_last4"
  | "customer_email"
  | "customer_name"
  | "notification_destination"
  | "fulfillment_status"
  | "tracking_number";

const DISCLOSURE_TO_REVEAL: Record<OrderDisclosureField, OrderRevealField> = {
  shipping_address: "shippingAddress",
  order_history: "fullPreviousOrderHistory",
  full_order_details: "historicalOrderDetails",
  line_items: "itemTitle",
  total_amount: "totalAmount",
  shipping_amount: "shippingFee",
  payment_method: "paymentGateway",
  card_last4: "paymentCardLast4",
  customer_email: "fullCustomerEmail",
  customer_name: "customerName",
  notification_destination: "notificationDestinationMasked",
  fulfillment_status: "fulfillmentStatus",
  tracking_number: "trackingNumber",
};

const SHIPPING_ADDRESS_RE =
  /\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped|ship\s+to|mailing\s+address)\b/i;

const ORDER_HISTORY_RE =
  /\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders|what\s+did\s+i\s+order\s+in|orders\s+in\s+\w+)\b/i;

const FULL_ORDER_DETAILS_RE =
  /\b(all\s+(?:the\s+)?(?:order\s+)?details|every\s+detail|full\s+order\s+details|tell\s+me\s+everything\s+about|everything\s+about\s+(?:the\s+)?order)\b/i;

/** Map caller utterance to a disclosure field when unambiguous. */
export function resolveDisclosureFieldFromUtterance(text: string): OrderDisclosureField | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (SHIPPING_ADDRESS_RE.test(trimmed)) return "shipping_address";
  if (ORDER_HISTORY_RE.test(trimmed)) return "order_history";
  if (FULL_ORDER_DETAILS_RE.test(trimmed)) return "full_order_details";
  if (/\b(product\s+title|item\s+title|book\s+title|what\s+is\s+the\s+title|what'?s\s+the\s+title|which\s+books?|what\s+did\s+(?:i|you)\s+order)\b/i.test(trimmed)) {
    return "line_items";
  }
  if (/\b(total\s+amount|order\s+total|what\s+is\s+the\s+total)\b/i.test(trimmed)) return "total_amount";
  if (/\b(shipping\s+(?:fee|fees|cost|amount))\b/i.test(trimmed)) return "shipping_amount";
  if (/\b(payment\s+method|what\s+card|card\s+ending)\b/i.test(trimmed)) return "payment_method";
  if (/\b(card\s+ending|last\s+(?:four|4)\s+digits?)\b/i.test(trimmed)) return "card_last4";
  if (/\b(customer\s+email|what\s+email|email\s+on\s+(?:the\s+)?order)\b/i.test(trimmed)) {
    return "customer_email";
  }
  if (/\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+ordered)\b/i.test(trimmed)) {
    return "customer_name";
  }
  if (/\b(where\s+(?:was|is)\s+(?:the\s+)?confirmation\s+sent|confirmation\s+(?:sent|delivery)|notification\s+(?:sent|delivery))\b/i.test(trimmed)) {
    return "notification_destination";
  }
  if (/\b(order\s+status|where\s+is\s+my\s+order|status\s+of\s+my\s+order)\b/i.test(trimmed)) {
    return "fulfillment_status";
  }
  if (/\b(tracking\s+(?:id|number)|tracking)\b/i.test(trimmed)) return "tracking_number";
  return null;
}

export function disclosureTier(session: CallSession): DisclosureTier {
  return disclosureTierForSession(session);
}

export function isCallerVerified(session: CallSession): boolean {
  return session.isVerifiedCaller === true;
}

/** True when the caller may receive this field on the current order. */
export function isFieldDisclosureAllowed(
  session: CallSession,
  field: OrderDisclosureField,
): boolean {
  const revealField = DISCLOSURE_TO_REVEAL[field];
  return canRevealOrderField(revealField, session.isVerifiedCaller === true);
}

/** True when an unverified caller must be refused before deterministic or LLM disclosure. */
export function shouldRefuseUnverifiedFieldQuery(
  session: CallSession,
  callerText: string,
): boolean {
  if (isCallerVerified(session)) return false;
  const field = resolveDisclosureFieldFromUtterance(callerText);
  if (!field) return false;
  return !isFieldDisclosureAllowed(session, field);
}

export function buildVerificationRefusalSpeech(session: CallSession): string {
  const name = String(
    session.currentOrderData?.customer_name ?? session.currentOrder?.customerName ?? "",
  ).trim();
  return buildUnverifiedRestrictedFieldRefusal(name || undefined);
}
