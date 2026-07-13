/**
 * VerificationGate — caller_number vs Shopify customer phone before vault access.
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import type { CallSession } from "../types/order.js";
import { applyCallerVerificationFromOrder } from "./callerVerification.js";

export type DisclosureTier = "public" | "vault";

/** Canonical order fields for permission checks — single source of truth. */
export type OrderRevealField =
  | "orderNumber"
  | "orderStatus"
  | "fulfillmentStatus"
  | "trackingNumber"
  | "trackingCompany"
  | "itemTitle"
  | "itemQuantity"
  | "itemPrice"
  | "subtotalAmount"
  | "shippingFee"
  | "totalAmount"
  | "paymentStatus"
  | "paymentGateway"
  | "notificationDestinationMasked"
  | "previousOrderCount"
  | "shippingAddress"
  | "fullCustomerPhone"
  | "fullCustomerEmail"
  | "customerName"
  | "fullPreviousOrderHistory"
  | "monthWiseOrderHistory"
  | "historicalOrderDetails"
  | "paymentCardLast4"
  | "orderNote"
  | "orderTags"
  | "timelineEvents"
  | "transactions";

const PUBLIC_REVEAL_FIELDS = new Set<OrderRevealField>([
  "orderNumber",
  "orderStatus",
  "fulfillmentStatus",
  "trackingNumber",
  "trackingCompany",
  "itemTitle",
  "itemQuantity",
  // Unverified callers may receive general order-state context.
  "orderNote",
  "orderTags",
  "timelineEvents",
]);

/** Field-by-field disclosure — non-verified callers receive public fields only. */
export function canRevealOrderField(
  fieldName: OrderRevealField,
  isVerifiedCaller: boolean,
): boolean {
  if (PUBLIC_REVEAL_FIELDS.has(fieldName)) return true;
  return isVerifiedCaller;
}

const LEGACY_KEY_TO_REVEAL_FIELD: Record<string, OrderRevealField> = {
  status: "orderStatus",
  fulfillment_status: "fulfillmentStatus",
  refund_status: "paymentStatus",
  tracking_number: "trackingNumber",
  tracking_id: "trackingNumber",
  tracking_company: "trackingCompany",
  masked_email: "notificationDestinationMasked",
  masked_phone: "notificationDestinationMasked",
  notification_destination: "notificationDestinationMasked",
  line_items: "itemTitle",
  physical_items: "itemTitle",
  item_title: "itemTitle",
  item_quantity: "itemQuantity",
  item_price: "itemPrice",
  subtotal_amount: "subtotalAmount",
  shipping_amount: "shippingFee",
  total_amount: "totalAmount",
  payment_status: "paymentStatus",
  payment_gateway: "paymentGateway",
  payment_method: "paymentGateway",
  previous_order_count: "previousOrderCount",
  order_history: "fullPreviousOrderHistory",
  shipping_address: "shippingAddress",
  billing_address: "shippingAddress",
  full_email: "fullCustomerEmail",
  customer_email: "fullCustomerEmail",
  customer_name: "customerName",
  card_last4: "paymentCardLast4",
  payment_method_last4: "paymentCardLast4",
  note: "orderNote",
  order_note: "orderNote",
  tags: "orderTags",
  events: "timelineEvents",
  transactions: "transactions",
};

/** Compare Twilio caller ID to Shopify customer phone — sets session.isVerifiedCaller. */
export function runVerificationGate(
  session: CallSession,
  result: OrderStatusResult,
): boolean {
  applyCallerVerificationFromOrder(session, result);
  return session.isVerifiedCaller === true;
}

export function disclosureTierForSession(session: CallSession): DisclosureTier {
  return session.isVerifiedCaller === true ? "vault" : "public";
}

export function isFieldAuthorizedForCaller(
  session: CallSession,
  fieldKey: string,
): boolean {
  const key = fieldKey.trim().toLowerCase();
  const revealField = LEGACY_KEY_TO_REVEAL_FIELD[key];
  if (revealField) {
    return canRevealOrderField(revealField, session.isVerifiedCaller === true);
  }
  return session.isVerifiedCaller === true;
}

/** Truncated email for unverified callers — e.g. "...@gmail.com". */
export function maskEmailForUnverified(email: string | null | undefined): string | null {
  if (!email?.trim() || !email.includes("@")) return null;
  const domain = email.trim().split("@").pop();
  if (!domain) return null;
  return `...@${domain.toLowerCase()}`;
}

/** Truncated phone for unverified callers — e.g. "*** *** 1234". */
export function maskPhoneForUnverified(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return null;
  const last4 = digits.slice(-4);
  return `*** *** ${last4}`;
}
