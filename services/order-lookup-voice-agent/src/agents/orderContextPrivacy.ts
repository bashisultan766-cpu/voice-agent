/**
 * PII guardrails for LLM-injected order context — unverified callers get deep current-order data.
 * Strict lock: shipping address and detailed past order history only.
 * Notes, tags, timeline events, staff comments, and transactions stay available.
 */
import type { ActiveOrderContextData } from "./sessionManager.js";

/** Vault-only fields stripped from LLM context for unverified callers. */
const UNVERIFIED_STRIPPED_CONTEXT_KEYS = [
  "shipping_address",
  "billing_address",
] as const;

/**
 * Deep current-order keys that MUST remain for unverified callers.
 * Documented so future filters do not accidentally strip A-to-Z context.
 */
export const UNVERIFIED_ALLOWED_DEEP_CONTEXT_KEYS = [
  "note",
  "order_note",
  "tags",
  "events",
  "transactions",
  "custom_attributes",
  "source_name",
  "channel_name",
  "publication_name",
  "is_draft_order_origin",
  "payment_method",
  "payment_method_last4",
  "payment_gateway",
  "card_brand",
  "total_order_count",
] as const;

/** Strip vault fields from order JSON before LLM injection for unverified callers. */
export function filterOrderContextForVerification(
  data: ActiveOrderContextData,
  isVerified: boolean,
): ActiveOrderContextData {
  if (isVerified) return data;

  const copy: ActiveOrderContextData = { ...data };
  for (const key of UNVERIFIED_STRIPPED_CONTEXT_KEYS) {
    if (key in copy) copy[key] = null;
  }
  // Explicitly preserve deep current-order context (do not strip).
  for (const key of UNVERIFIED_ALLOWED_DEEP_CONTEXT_KEYS) {
    if (key in data) copy[key] = data[key];
  }
  copy.privacy_tier = "unverified";
  copy.vault_access = "restricted";
  return copy;
}

const SHIPPING_ADDRESS_RE =
  /\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped|ship\s+to|mailing\s+address)\b/i;

const DETAILED_ORDER_HISTORY_RE =
  /\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders|what\s+did\s+i\s+order\s+in|orders?\s+in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)|get_customer_history|customer\s+history)\b/i;

/** Vault-only queries an unverified caller must not receive via deterministic speech. */
export function isRestrictedFieldQueryForUnverified(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (SHIPPING_ADDRESS_RE.test(text)) return true;
  if (DETAILED_ORDER_HISTORY_RE.test(text)) return true;
  return false;
}

export function buildUnverifiedRestrictedFieldRefusal(customerName?: string): string {
  const name = String(customerName ?? "the registered customer").trim() || "the registered customer";
  return (
    "For security purposes, since you are calling from an unverified number, I cannot share the shipping address or your past order history on this call. " +
    `I am sorry, but I can only share that information with the verified account holder, ${name}.`
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
  if (/\b(refund\s+reason|cancel\s+reason|why\s+(?:was|is)\s+(?:it|my\s+order)\s+(?:refunded|cancelled))\b/i.test(text)) {
    return !String(context.cancel_reason ?? context.refund_reason ?? "").trim();
  }
  if (/\b(order\s+status|where\s+is\s+my\s+order|status\s+of\s+my\s+order)\b/i.test(text)) {
    return !String(context.fulfillment_status ?? context.refund_status ?? "").trim();
  }
  if (/\b(how\s+many\s+books|item\s+count)\b/i.test(text)) {
    return context.item_count == null;
  }
  if (/\b(note|notes|tag|tags|timeline|staff\s+comment|draft\s+order)\b/i.test(text)) {
    return (
      !String(context.note ?? context.order_note ?? "").trim() &&
      !(Array.isArray(context.tags) && context.tags.length > 0) &&
      !(Array.isArray(context.events) && context.events.length > 0)
    );
  }

  return false;
}
