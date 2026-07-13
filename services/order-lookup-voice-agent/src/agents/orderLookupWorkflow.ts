/**
 * Single order-lookup workflow — shared speech, retry signals, and status classification.
 * Found orders use Concierge Gateway speech only (status + follow-up; no automatic dump).
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import {
  ORDER_LOOKUP_MAINTENANCE_SPOKEN,
  ORDER_LOOKUP_RETRY_SPOKEN,
  ORDER_NOT_FOUND_STRICT_SPOKEN,
  SHOPIFY_TIMEOUT_SPOKEN,
} from "../constants/systemMessages.js";
import type { CallSession } from "../types/order.js";
import { orderNumbersMatch } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import { groundedOrderSpeech } from "./fulfillmentHandlers.js";
import {
  ORDER_FOUND_PASSIVE_SPEECH,
  buildOrderFoundGatewaySpeech,
} from "./orderLookupProtocol.js";
import { hasConfirmedOrderContext } from "./orderContextPolicy.js";

export { ORDER_FOUND_PASSIVE_SPEECH, buildOrderFoundGatewaySpeech };

/** True when this call session already completed a successful order lookup. */
export function isOrderLookupComplete(session?: CallSession): boolean {
  return Boolean(session?.orderLookupComplete) || hasConfirmedOrderContext(session);
}

/**
 * Context lock: after order_lookup_complete, forbid re-calling get_shopify_order_status
 * for the same order — rely on cached JSON. Allow only when the caller names a different order.
 */
export function shouldBlockOrderLookupReinvoke(
  session: CallSession | undefined,
  requestedOrderNumber?: string,
): boolean {
  if (!isOrderLookupComplete(session)) return false;

  const cached = String(
    session?.currentOrderData?.order_number ??
      session?.currentOrder?.orderNumber ??
      session?.lastOrderStatusResult?.orderNumber ??
      "",
  );
  if (!cached) return true;

  const requested = normalizeOrderNumber(requestedOrderNumber ?? "");
  if (!requested) return true;

  return orderNumbersMatch(cached, requested);
}

export function markOrderLookupComplete(session: CallSession): void {
  session.orderLookupComplete = true;
}

export function clearOrderLookupComplete(session: CallSession): void {
  session.orderLookupComplete = false;
}

export function isOrderLookupInsistenceUtterance(text: string): boolean {
  return /\b((?:this\s+is\s+the\s+)?correct|right)\s+order|please\s+(?:find|look\s*(?:it\s+)?up|try\s+again|provide)\b/i.test(
    text.trim(),
  );
}

export function isTransientOrderLookupStatus(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "api_error" || status === "system_maintenance" || status === "throttled";
}

/**
 * Only cache durable positive / format failures.
 * Never cache `not_found` — a first Shopify miss must not block the next live retry
 * when the caller insists with the same digits (common after STT noise or a brief miss).
 */
export function isStableOrderLookupStatus(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "found" || status === "invalid_format";
}

/** Deterministic spoken response for any order lookup tool result — one workflow, no LLM paraphrase. */
export function speechForOrderLookupResult(
  result: OrderStatusResult,
  options?: { insistence?: boolean; session?: CallSession },
): string {
  if (
    result.status === "api_error" &&
    /timeout/i.test(String(result.message ?? ""))
  ) {
    return SHOPIFY_TIMEOUT_SPOKEN;
  }
  if (options?.insistence && isTransientOrderLookupStatus(result.status)) {
    return ORDER_LOOKUP_RETRY_SPOKEN;
  }
  if (isTransientOrderLookupStatus(result.status)) {
    return ORDER_LOOKUP_MAINTENANCE_SPOKEN;
  }
  if (result.status === "found") {
    return groundedOrderSpeech(result, options?.session);
  }
  if (result.status === "not_found") {
    return ORDER_NOT_FOUND_STRICT_SPOKEN;
  }
  return groundedOrderSpeech(result, options?.session);
}

export function isRetriableOrderLookupMiss(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "not_found";
}

export function shouldBypassOrderLookupCache(
  userMessage: string,
  phase?: string,
): boolean {
  if (isOrderLookupInsistenceUtterance(userMessage)) return true;
  if (phase === "awaiting_order_number") return true;
  return /\b(try\s+again|one\s+more\s+time|digit\s+by\s+digit|check\s+(?:the\s+)?system|search\s+again)\b/i.test(
    userMessage.trim(),
  );
}
