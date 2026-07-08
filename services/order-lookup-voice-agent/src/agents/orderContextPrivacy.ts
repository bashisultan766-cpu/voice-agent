/**
 * PII guardrails for LLM-injected order context — unverified callers get a reduced payload.
 */
import type { ActiveOrderContextData } from "./sessionManager.js";

const UNVERIFIED_STRIPPED_CONTEXT_KEYS = [
  "shipping_address",
  "physical_items",
  "fee_items",
  "items",
  "processing_fees",
  "shipping_fees",
  "handling_fees",
  "events",
  "order_confirmation_email",
  "order_confirmation_email_for_tts",
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
  copy.privacy_tier = "unverified";
  copy.vault_access = "restricted";
  return copy;
}

const SHIPPING_ADDRESS_RE =
  /\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped|ship\s+to|mailing\s+address)\b/i;

const LINE_ITEM_DRILLDOWN_RE =
  /\b(line\s*items?|what\s+books|which\s+books|item\s+details|physical\s+items|book\s+titles?\s+on\s+(?:the\s+)?order)\b/i;

/** Vault-only fields an unverified caller must not receive via deterministic speech. */
export function isRestrictedFieldQueryForUnverified(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (SHIPPING_ADDRESS_RE.test(text)) return true;
  if (LINE_ITEM_DRILLDOWN_RE.test(text)) return true;
  if (/\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders)\b/i.test(text)) {
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
