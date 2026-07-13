/**
 * Call-session order context — persists Shopify deep-fetch across turns
 * and builds invisible LLM injection payloads for follow-up answers.
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import { buildActiveOrderContextPayload } from "../adapters/llmToolExecutor.js";
import type { LlmToolExecutionRecord } from "../adapters/llmToolExecutor.js";
import type { CallSession } from "../types/order.js";
import { orderNumbersMatch } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import { logger } from "../utils/logger.js";
import {
  clearOrderContextConfirmation,
  markOrderContextConfirmed,
} from "./orderContextPolicy.js";

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

export function buildActiveOrderContextFromResult(
  result: OrderStatusResult,
  session?: CallSession,
): ActiveOrderContextData | null {
  if (result.status !== "found" || !result.orderNumber) return null;
  return buildActiveOrderContextPayload(result, session);
}

export function buildActiveOrderContextFromToolRecord(
  record: LlmToolExecutionRecord,
  session?: CallSession,
): ActiveOrderContextData | null {
  if (
    record.tool !== "get_shopify_order_status" ||
    !record.ok ||
    !record.data ||
    !("orderNumber" in record.data) ||
    record.data.status !== "found"
  ) {
    return null;
  }
  return buildActiveOrderContextFromResult(record.data, session);
}

export function saveActiveOrderContext(
  session: CallSession,
  data: ActiveOrderContextData,
): void {
  const previous = session.currentOrderData;
  const previousNumber = previous ? String(previous.order_number ?? "") : "";
  const nextNumber = String(data.order_number ?? "");

  if (previous && previousNumber && nextNumber && !orderNumbersMatch(previousNumber, nextNumber)) {
    logger.info("active_order_context_replaced", {
      callSid: session.callSid.slice(0, 8),
      previousOrderNumber: previousNumber,
      nextOrderNumber: nextNumber,
    });
  }

  session.currentOrderData = data;
  markOrderContextConfirmed(session);
}

export function clearActiveOrderContext(session: CallSession): void {
  session.currentOrderData = undefined;
  clearOrderContextConfirmation(session);
}

/** True when a newly spoken order number should replace persisted context. */
export function shouldReplaceOrderContext(
  session: CallSession,
  spokenOrderNumber: string,
): boolean {
  if (!session.currentOrderData) return true;

  const existing = String(session.currentOrderData.order_number ?? "");
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
