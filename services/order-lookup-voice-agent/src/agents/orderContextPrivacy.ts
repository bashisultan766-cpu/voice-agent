/**
 * PII guardrails for LLM-injected order context.
 * Unverified callers receive public_data only; secure_data stays null/restricted.
 */
import type { ActiveOrderContextData } from "./sessionManager.js";

/** Secure / vault fields stripped from flat context for unverified callers. */
const UNVERIFIED_STRIPPED_CONTEXT_KEYS = [
  "secure_data",
  "shipping_address",
  "billing_address",
  "past_order_history",
  "customer_email",
  "customer_email_for_tts",
  "customer_name",
  "customer_phone",
  "payment_method",
  "payment_method_last4",
  "payment_gateway",
  "card_brand",
  "total_amount",
  "shipping_amount",
  "subtotal_amount",
  "total_tax",
  "total_discounts",
  "fee_items",
  "processing_fees",
  "shipping_fees",
  "handling_fees",
  "refund_status",
  "refund_reason",
  "cancel_reason",
  "refund_amount",
  "refund_notification_email",
  "refund_notification_email_for_tts",
  "order_confirmation_email",
  "order_confirmation_email_for_tts",
  // Timeline/tags/notes stay available for unverified general order-state queries.
  "source_name",
  "channel_name",
  "publication_name",
  "custom_attributes",
  "transactions",
  "order_placed_at",
  "refund_date",
  "total_order_count",
] as const;

/** Public keys that remain available for unverified callers. */
export const UNVERIFIED_ALLOWED_PUBLIC_CONTEXT_KEYS = [
  "public_data",
  "order_number",
  "fulfillment_status",
  "estimated_delivery_days",
  "tracking_number",
  "tracking_company",
  "tracking_number_for_tts",
  "tracking_status",
  "item_count",
  "physical_items",
  "items",
  "is_verified_caller",
  "events",
  "note",
  "order_note",
  "tags",
  "metafields",
] as const;

/** Strip vault fields from order JSON before LLM injection for unverified callers. */
export function filterOrderContextForVerification(
  data: ActiveOrderContextData,
  isVerified: boolean,
): ActiveOrderContextData {
  if (isVerified) {
    const granted: ActiveOrderContextData = { ...data };
    granted.privacy_tier = "verified";
    granted.vault_access = "granted";
    return granted;
  }

  const copy: ActiveOrderContextData = { ...data };
  for (const key of UNVERIFIED_STRIPPED_CONTEXT_KEYS) {
    if (key === "transactions" || key === "custom_attributes") {
      copy[key] = [];
    } else {
      copy[key] = null;
    }
  }
  for (const key of UNVERIFIED_ALLOWED_PUBLIC_CONTEXT_KEYS) {
    if (key in data) copy[key] = data[key];
  }
  copy.secure_data = null;
  copy.shipping_address = null;
  copy.past_order_history = null;
  copy.privacy_tier = "unverified";
  copy.vault_access = "restricted";
  return copy;
}

const SHIPPING_ADDRESS_RE =
  /\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped|ship\s+to|mailing\s+address)\b/i;

const DETAILED_ORDER_HISTORY_RE =
  /\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders|what\s+did\s+i\s+order\s+in|orders?\s+in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)|get_customer_history|customer\s+history)\b/i;

const SECURE_FIELD_RE =
  /\b(email|card\s+(?:ending|last)|last\s*4|payment\s+method|total\s+amount|order\s+total|how\s+much|transaction|account\s+deposit)\b/i;

/** Vault-only queries an unverified caller must not receive via deterministic speech. */
export function isRestrictedFieldQueryForUnverified(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (SHIPPING_ADDRESS_RE.test(text)) return true;
  if (DETAILED_ORDER_HISTORY_RE.test(text)) return true;
  if (SECURE_FIELD_RE.test(text)) return true;
  return false;
}

export function buildUnverifiedRestrictedFieldRefusal(customerName?: string): string {
  const name = String(customerName ?? "the registered customer").trim() || "the registered customer";
  return (
    "For security purposes, since you are calling from an unverified number, I can only share public order status and tracking details on this call. " +
    `I am sorry, but I can only share private account details with the verified account holder, ${name}.`
  );
}

export function buildUnverifiedShippingAddressRefusal(): string {
  return (
    "For security purposes, since you are calling from an unverified number, I cannot provide the shipping address on this call. " +
    "I can forward your request to support if you'd like."
  );
}

/** True when the caller asks for a field absent from the current order context payload. */
export function orderUtteranceNeedsFreshLookup(
  callerText: string,
  context: ActiveOrderContextData,
  isVerifiedCaller = true,
): boolean {
  const text = callerText.trim();
  if (!text) return false;

  if (!isVerifiedCaller && isRestrictedFieldQueryForUnverified(text)) {
    return false;
  }

  if (/\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+ordered)\b/i.test(text)) {
    return !String(context.customer_name ?? "").trim();
  }
  if (/\b(total\s+amount|order\s+total|how\s+much)\b/i.test(text)) {
    return context.total_amount == null && context.subtotal_amount == null;
  }
  if (/\b(shipping\s+(?:fee|cost)|shipping\s+amount)\b/i.test(text)) {
    return context.shipping_amount == null;
  }
  if (/\b(payment\s+method|card\s+ending|what\s+card|account\s+deposit|manual(?:ly)?\s+(?:marked|paid))\b/i.test(text)) {
    return (
      !String(context.payment_method ?? "").trim() &&
      !(Array.isArray(context.transactions) && context.transactions.length > 0) &&
      !(Array.isArray(context.events) && context.events.length > 0) &&
      !String(context.note ?? context.order_note ?? "").trim()
    );
  }
  if (/\b(customer\s+email|what\s+email|email\s+on\s+(?:the\s+)?order|confirmation\s+email|notification\s+email)\b/i.test(text)) {
    return (
      !String(context.customer_email ?? "").trim() &&
      !String(context.order_confirmation_email ?? "").trim() &&
      !String(context.refund_notification_email ?? "").trim()
    );
  }
  if (/\b(tracking|track\s+(?:my\s+)?(?:package|order|shipment))\b/i.test(text)) {
    return !String(context.tracking_number ?? "").trim();
  }
  return false;
}
