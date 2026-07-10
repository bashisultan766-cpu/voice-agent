/**
 * PII guardrails for LLM-injected order context — unverified callers get a reduced payload.
 */
import type { ActiveOrderContextData } from "./sessionManager.js";
import { maskEmailForUnverified, maskPhoneForUnverified } from "./verificationGate.js";

/** Vault-only fields stripped from LLM context for unverified callers. */
const UNVERIFIED_STRIPPED_CONTEXT_KEYS = [
  "shipping_address",
  "billing_address",
  "events",
  "order_confirmation_email",
  "order_confirmation_email_for_tts",
  "customer_email",
  "customer_email_for_tts",
  "customer_name",
  "customer_phone",
  "payment_method",
  "payment_method_last4",
  "card_brand",
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

const DETAILED_ORDER_HISTORY_RE =
  /\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders|what\s+did\s+i\s+order\s+in|orders?\s+in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec))\b/i;

const FULL_ORDER_DETAILS_RE =
  /\b(all\s+(?:the\s+)?(?:order\s+)?details|every\s+detail|full\s+order\s+details|tell\s+me\s+everything\s+about|everything\s+about\s+(?:the\s+)?order)\b/i;

const CUSTOMER_NAME_RE =
  /\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+is\s+this\s+order\s+for|who\s+ordered|what\s+is\s+the\s+name|what'?s\s+the\s+name)\b/i;

const FULL_CUSTOMER_EMAIL_RE =
  /\b(customer\s+email|what\s+email|email\s+on\s+(?:the\s+)?order|full\s+email)\b/i;

const PAYMENT_VAULT_RE =
  /\b(payment\s+method|what\s+card|card\s+ending|last\s+(?:four|4)\s+digits?|ending\s+in\s+\d)\b/i;

const NOTIFICATION_PHONE_RE =
  /\b(notification\s+phone|phone\s+on\s+(?:the\s+)?order|customer\s+phone)\b/i;

/** Vault-only queries an unverified caller must not receive via deterministic speech. */
export function isRestrictedFieldQueryForUnverified(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (SHIPPING_ADDRESS_RE.test(text)) return true;
  if (DETAILED_ORDER_HISTORY_RE.test(text)) return true;
  if (FULL_ORDER_DETAILS_RE.test(text)) return true;
  if (CUSTOMER_NAME_RE.test(text)) return true;
  if (PAYMENT_VAULT_RE.test(text)) return true;
  if (NOTIFICATION_PHONE_RE.test(text)) return true;
  if (FULL_CUSTOMER_EMAIL_RE.test(text)) return true;
  return false;
}

export function buildUnverifiedRestrictedFieldRefusal(customerName?: string): string {
  const name = String(customerName ?? "the registered customer").trim() || "the registered customer";
  return (
    "For security purposes, since you are calling from an unverified number, I can only provide basic order status and tracking details. " +
    `I am sorry, but I can only share that information with the verified account holder, ${name}.`
  );
}

export function buildUnverifiedShippingAddressRefusal(): string {
  return (
    "For security purposes, since you are calling from an unverified number, I can only provide basic order status and tracking details. " +
    "I can't provide the shipping address because this call is not verified. I can forward your request to support if you'd like."
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

