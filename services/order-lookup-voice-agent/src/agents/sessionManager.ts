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

export type ActiveOrderContextData = Record<string, unknown>;

export function buildActiveOrderContextFromResult(
  result: OrderStatusResult,
): ActiveOrderContextData | null {
  if (result.status !== "found" || !result.orderNumber) return null;
  return buildActiveOrderContextPayload(result);
}

export function buildActiveOrderContextFromToolRecord(
  record: LlmToolExecutionRecord,
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
  return buildActiveOrderContextFromResult(record.data);
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
}

export function clearActiveOrderContext(session: CallSession): void {
  session.currentOrderData = undefined;
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
): string {
  return (
    "ACTIVE ORDER CONTEXT: The user is currently discussing this order. " +
    "Use this JSON data to answer follow-up questions accurately. Do not invent data. " +
    "You have the full order timeline in events plus refund_notification_email, " +
    "order_confirmation_email, and refund_reason — never claim you lack access when those fields are present. " +
    "Do not call get_shopify_order_status again unless the user provides a different order number. " +
    `JSON: ${JSON.stringify(data)}`
  );
}
