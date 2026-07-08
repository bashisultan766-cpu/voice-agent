/**
 * Order context is only actionable after an explicit order-number lookup this call.
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import { lookupOrderStatus } from "../services/shopifyService.js";
import type { CallSession, OrderLookupResult } from "../types/order.js";
import { applyCallerVerificationFromOrder } from "./callerVerification.js";
import { orderStatusToStructuredOrder } from "./fulfillmentHandlers.js";
import { buildActiveOrderContextFromResult, saveActiveOrderContext } from "./sessionManager.js";

export function hasConfirmedOrderContext(session?: CallSession): boolean {
  return Boolean(
    session?.orderContextConfirmed &&
    session.currentOrderData &&
    Object.keys(session.currentOrderData).length > 0,
  );
}

export function markOrderContextConfirmed(session: CallSession): void {
  session.orderContextConfirmed = true;
}

export function clearOrderContextConfirmation(session: CallSession): void {
  session.orderContextConfirmed = false;
}

/** Caller wants order help but has not supplied an order number yet. */
export function isOrderLookupRequestWithoutNumber(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\b\d{4,}\b/.test(trimmed)) return false;
  return (
    /\b(?:how\s+can\s+i\s+get|want\s+(?:to\s+)?know|need\s+(?:to\s+)?know|tell\s+me\s+about)\b.*\b(?:my\s+)?order\b/i.test(
      trimmed,
    ) ||
    /\b(?:order\s+details|details\s+(?:of|about)\s+(?:my\s+)?order|information\s+about\s+(?:my\s+)?order|about\s+my\s+order)\b/i.test(
      trimmed,
    ) ||
    /\b(?:where\s+is\s+my\s+order|order\s+status|status\s+of\s+(?:my\s+)?order|track\s+my\s+order|lookup\s+(?:my\s+)?order)\b/i.test(
      trimmed,
    ) ||
    (/\border\b/i.test(trimmed) &&
      /\b(details|information|status|track|lookup|find)\b/i.test(trimmed) &&
      !/\b(book|books|isbn|title|product|buy|purchase|cart)\b/i.test(trimmed))
  );
}

/** Single Shopify lookup — persists confirmed order context for follow-up turns. */
export async function executeOrderLookupForSession(
  session: CallSession,
  orderNumber: string,
): Promise<OrderLookupResult> {
  const data: OrderStatusResult = await lookupOrderStatus(orderNumber, session.callSid, {
    bypassCache: true,
  });

  if (data.status === "found") {
    const structured = orderStatusToStructuredOrder(data);
    if (!structured) {
      return { status: "api_error", message: "Order lookup returned incomplete data." };
    }
    session.currentOrder = structured;
    applyCallerVerificationFromOrder(session, data);
    const payload = buildActiveOrderContextFromResult(data, session);
    if (payload) {
      saveActiveOrderContext(session, payload);
    }
    return { status: "found", order: structured };
  }

  if (data.status === "not_found") {
    return { status: "not_found" };
  }

  if (data.status === "invalid_format") {
    return { status: "invalid_format", message: data.message ?? "Invalid order number." };
  }

  return { status: "api_error", message: data.message ?? "Shopify API unavailable" };
}
