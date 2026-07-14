/**
 * Active order disclosure context — the sanitized snake_case DTO used by the
 * LLM system message + follow-up speech. Never carries the raw Shopify
 * OrderStatusResult (that lives inside protected-data modules only).
 */
import type { CallSession } from "../types/order.js";
import { orderNumbersMatch } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import { logger } from "../utils/logger.js";
import {
  clearOrderContextConfirmation,
  markOrderContextConfirmed,
} from "./orderContextPolicy.js";
import {
  buildOrderView,
  ORDER_DISCLOSURE_POLICY_VERSION,
  type OrderView,
} from "./orderDisclosurePolicy.js";

export type ActiveOrderContextData = Record<string, unknown>;

const TRACKING_CONTEXT_KEYS = [
  "tracking_number",
  "tracking_number_for_tts",
  "tracking_company",
  "tracking_status",
] as const;

/** Hide tracking digits from LLM until notepad handshake completes. */
export function redactTrackingFromOrderContext(
  data: ActiveOrderContextData,
  notepadReady: boolean,
): ActiveOrderContextData {
  if (notepadReady) return data;
  const copy = { ...data };
  for (const key of TRACKING_CONTEXT_KEYS) {
    if (key in copy) copy[key] = null;
  }
  copy.tracking_redacted_until_notepad_ready = true;
  return copy;
}

export function saveActiveOrderContext(
  session: CallSession,
  data: ActiveOrderContextData,
): void {
  const previous = session.sessionOrderContext?.orderView;
  const previousNumber = previous ? String(previous.order_number ?? "") : "";
  const nextNumber = String(data.order_number ?? "");

  if (previous && previousNumber && nextNumber && !orderNumbersMatch(previousNumber, nextNumber)) {
    logger.info("active_order_context_replaced", {
      callSid: session.callSid.slice(0, 8),
      previousOrderNumber: previousNumber,
      nextOrderNumber: nextNumber,
    });
  }

  const orderView = buildOrderView(session, data);
  const orderNumber = String(orderView.order_number ?? "").replace(/^#/, "").trim();
  session.sessionOrderContext = {
    orderReferenceId: orderNumber,
    orderNumber,
    verificationLevel: session.isVerifiedCaller === true ? "verified" : "unverified",
    disclosurePolicyVersion: ORDER_DISCLOSURE_POLICY_VERSION,
    orderView,
    fetchedAt: Date.now(),
  };
  markOrderContextConfirmed(session);
  if (orderNumber) {
    session.currentSessionOrder = {
      orderNumber,
      customerName:
        typeof data.customer_name === "string" ? data.customer_name : undefined,
      fulfillmentStatus:
        typeof data.fulfillment_status === "string"
          ? data.fulfillment_status
          : undefined,
      financialStatus:
        typeof data.financial_status === "string" ? data.financial_status : undefined,
    };
  }
}

/**
 * Single source of truth for active order disclosure context.
 * SessionOrderContext.orderView is the disclosure-safe source of truth.
 */
export function getActiveOrderContext(
  session?: CallSession,
): OrderView | undefined {
  return session?.sessionOrderContext?.orderView;
}

/** Order number from SSOT (falls back to projection only if data missing). */
export function getActiveOrderNumber(session?: CallSession): string | undefined {
  const fromSsot = String(session?.sessionOrderContext?.orderView.order_number ?? "")
    .replace(/^#/, "")
    .trim();
  if (fromSsot) return fromSsot;
  const projected = String(session?.currentSessionOrder?.orderNumber ?? "")
    .replace(/^#/, "")
    .trim();
  return projected || undefined;
}

/** True when sticky order context indicates tracking is on file (digits may live in sovereign payload). */
export function hasActiveOrderTracking(session?: CallSession): boolean {
  const view = getActiveOrderContext(session);
  if (!view) return false;
  if (view.tracking_available === true) return true;
  return Boolean(String(view.tracking_number ?? "").trim());
}

/** Tracking digits when present on the in-memory OrderView (tests / pre-persist payloads only). */
export function getActiveOrderTrackingNumber(session?: CallSession): string {
  return String(getActiveOrderContext(session)?.tracking_number ?? "").trim();
}

export function clearActiveOrderContext(session: CallSession): void {
  session.currentSessionOrder = undefined;
  session.sessionOrderContext = undefined;
  clearOrderContextConfirmation(session);
}

/** True when a newly spoken order number should replace persisted context. */
export function shouldReplaceOrderContext(
  session: CallSession,
  spokenOrderNumber: string,
): boolean {
  const active = getActiveOrderContext(session);
  if (!active) return true;

  const existing = String(active.order_number ?? "");
  if (!existing) return true;

  const normalized = normalizeOrderNumber(spokenOrderNumber);
  if (!normalized) return false;

  return !orderNumbersMatch(existing, normalized);
}

export function buildActiveOrderContextSystemMessage(
  data: ActiveOrderContextData,
  options?: { catalogPivot?: boolean },
): string {
  if (options?.catalogPivot) {
    return (
      "ACTIVE ORDER CONTEXT (BACKGROUND ONLY): An order was previously loaded this call, " +
      "but the caller just pivoted to buying / searching the catalog. " +
      "Do NOT restate order status, fulfillment, or the full order summary. " +
      "Call search_shopify_book_by_title or search_shopify_book_by_isbn, then update_cart_item_quantity / send_checkout_email as needed. " +
      `Prior order JSON (reference only): ${JSON.stringify(data)}`
    );
  }
  return (
    "ACTIVE ORDER CONTEXT: The user is currently discussing this order. " +
    "Use this JSON data to answer follow-up questions accurately. Do not invent data. " +
    "SECURITY OVERRIDE FOR UNVERIFIED CALLERS: If isVerifiedCaller is false, you MUST STILL provide excellent support. " +
    "ABSOLUTE BLACKLIST (NEVER SHARE): shipping_address and past_order_history. You must refuse to share these. " +
    "ABSOLUTE WHITELIST (MUST SHARE IF ASKED): You are FULLY AUTHORIZED and REQUIRED to share the Customer Name, Customer Email, " +
    "Notification/Confirmation Emails, Item Titles, Item Quantities, Item Prices, Subtotal, Total Tax, Shipping Fees, Total Amount, " +
    "Timeline Events, Tags, and Notes. Do not hide financial data or customer names from unverified callers. " +
    "Answer all questions regarding the whitelist confidently. " +
    "If a VERIFICATION_CHALLENGE_GATE system block is present, follow it instead of naming items or speaking ledger/subscription/attachment details until verify_caller_challenge succeeds. " +
    "If verificationChallengePending is true, you MAY ask the caller to confirm the zip code or street / PO Box number on the shipping address, " +
    "then call verify_caller_challenge with what they said — do NOT invent the address, and do NOT read expectedZipCode from any prompt. " +
    "Translate events with THE SHOPIFY BRAIN — never read events verbatim, never speak staff names, never hang up. " +
    "NEVER say that blacklisted fields are \"not on file\" — refuse per RULE 1.1, then continue helping with whitelist fields. " +
    "When verified, secure_data also includes shipping_address, past_order_history, payment_method_last4, and transactions. " +
    "For notification questions, inspect events for Confirmation / Received new order / Draft order language. " +
    "For refund/confirmation email questions, use refund_notification_email_for_tts when present. " +
    "If refund_notification_email is null and order_placed_at is over 1 year old, apply LEGACY ORDER FALLBACK with customer_email_for_tts. " +
    "Do not call get_shopify_order_status again unless the user provides a different order number. " +
    `JSON: ${JSON.stringify(data)}`
  );
}

export { filterOrderContextForVerification } from "./orderContextPrivacy.js";
