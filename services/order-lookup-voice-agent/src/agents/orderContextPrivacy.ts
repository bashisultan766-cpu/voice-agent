/**
 * PII guardrails for LLM-injected order context — unverified callers get a reduced payload.
 */
import type { ActiveOrderContextData } from "./sessionManager.js";
import { maskEmailForUnverified, maskPhoneForUnverified } from "./verificationGate.js";

/** Vault-only fields — unverified callers still receive line items, totals, and fees. */
const UNVERIFIED_STRIPPED_CONTEXT_KEYS = [
  "shipping_address",
  "events",
  "order_confirmation_email",
  "order_confirmation_email_for_tts",
  "customer_email",
  "customer_email_for_tts",
  "customer_name",
  "payment_method",
  "payment_method_last4",
  "card_brand",
  "physical_items",
  "fee_items",
  "subtotal_amount",
  "total_amount",
  "shipping_amount",
] as const;

/** Strip vault fields from order JSON before LLM injection for unverified callers. */
export function filterOrderContextForVerification(
  data: ActiveOrderContextData,
  isVerified: boolean,
): ActiveOrderContextData {
  if (isVerified) return data;

  const email = String(data.customer_email ?? data.order_confirmation_email ?? "");
  const phone = String(data.customer_phone ?? data.shopify_customer_phone ?? "");

  const copy: ActiveOrderContextData = { ...data };
  for (const key of UNVERIFIED_STRIPPED_CONTEXT_KEYS) {
    if (key in copy) copy[key] = null;
  }
  copy.privacy_tier = "unverified";
  copy.vault_access = "restricted";
  if (email) {
    copy.masked_notification_email = maskEmailForUnverified(email);
  }
  if (phone) {
    copy.masked_notification_phone = maskPhoneForUnverified(phone);
  }
  return copy;
}

const SHIPPING_ADDRESS_RE =
  /\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped|ship\s+to|mailing\s+address)\b/i;

/** Vault-only fields an unverified caller must not receive via deterministic speech. */
export function isRestrictedFieldQueryForUnverified(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (SHIPPING_ADDRESS_RE.test(text)) return true;
  if (/\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders|what\s+did\s+i\s+order\s+in)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(all\s+(?:the\s+)?(?:order\s+)?details|every\s+detail|full\s+order\s+details|tell\s+me\s+everything\s+about|everything\s+about\s+(?:the\s+)?order)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

export function buildUnverifiedRestrictedFieldRefusal(customerName?: string): string {
  const name = String(customerName ?? "the registered customer").trim() || "the registered customer";
  return `I am sorry, but for security reasons, I can only share that information with the verified account holder, ${name}.`;
}

/** True when the caller asks for a field absent from the current order context payload. */
export function orderUtteranceNeedsFreshLookup(
  callerText: string,
  context: ActiveOrderContextData,
): boolean {
  const text = callerText.trim();
  if (!text) return false;

  if (/\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+ordered)\b/i.test(text)) {
    return !String(context.customer_name ?? "").trim();
  }
  if (/\b(total\s+amount|order\s+total|how\s+much)\b/i.test(text)) {
    return context.total_amount == null && context.subtotal_amount == null;
  }
  if (/\b(shipping\s+(?:fee|cost)|shipping\s+amount)\b/i.test(text)) {
    return context.shipping_amount == null;
  }
  if (/\b(payment\s+method|card\s+ending|what\s+card)\b/i.test(text)) {
    return !String(context.payment_method ?? "").trim();
  }
  if (/\b(customer\s+email|what\s+email|email\s+on\s+(?:the\s+)?order)\b/i.test(text)) {
    return !String(context.customer_email ?? "").trim();
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

  return false;
}
