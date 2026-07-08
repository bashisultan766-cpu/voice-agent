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
