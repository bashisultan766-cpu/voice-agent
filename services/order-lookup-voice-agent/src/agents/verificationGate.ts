/**
 * VerificationGate — caller_number vs Shopify customer phone before vault access.
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import type { CallSession } from "../types/order.js";
import { applyCallerVerificationFromOrder } from "./callerVerification.js";

export type DisclosureTier = "public" | "vault";

const PUBLIC_FIELDS = new Set([
  "status",
  "fulfillment_status",
  "refund_status",
  "tracking_number",
  "tracking_id",
  "masked_email",
  "masked_phone",
  "notification_destination",
]);

const VAULT_ONLY_FIELDS = new Set([
  "shipping_address",
  "billing_address",
  "full_email",
  "customer_email",
  "customer_name",
  "payment_method",
  "card_last4",
  "order_history",
  "line_items",
  "physical_items",
  "total_amount",
  "subtotal_amount",
  "shipping_amount",
]);

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
  if (PUBLIC_FIELDS.has(key)) return true;
  if (VAULT_ONLY_FIELDS.has(key)) {
    return session.isVerifiedCaller === true;
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
