/**
 * Order context is only actionable after an explicit order-number lookup this call.
 */
import { TRACKING_REQUEST_RE } from "./trackingIntent.js";
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import { lookupOrderStatus } from "../services/shopifyService.js";
import type { CallSession, OrderLookupResult } from "../types/order.js";
import { runVerificationGate } from "./verificationGate.js";
import { orderStatusToStructuredOrder } from "./fulfillmentHandlers.js";
import { buildActiveOrderContextFromResult, saveActiveOrderContext } from "./sessionManager.js";
import { orderNumbersMatch } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";

export function hasConfirmedOrderContext(session?: CallSession): boolean {
  return Boolean(
    session?.orderContextConfirmed &&
    session.currentOrderData &&
    Object.keys(session.currentOrderData).length > 0,
  );
}

export function markOrderContextConfirmed(session: CallSession): void {
  session.orderContextConfirmed = true;
  session.orderLookupComplete = true;
}

export function clearOrderContextConfirmation(session: CallSession): void {
  session.orderContextConfirmed = false;
  session.orderLookupComplete = false;
  session.currentSessionOrder = undefined;
}

/** Caller wants order help but has not supplied an order number yet. */
export function isOrderLookupRequestWithoutNumber(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\b\d{4,}\b/.test(trimmed)) return false;
  if (TRACKING_REQUEST_RE.test(trimmed) || /\btracking\s*(?:i\.?d\.?|it|i\s*t)\b/i.test(trimmed)) {
    return true;
  }
  if (
    /\b(?:my\s+)?order\b/i.test(trimmed) &&
    /\b(?:tracking|track)\b/i.test(trimmed) &&
    !/\b(book|books|isbn|title|product|buy|purchase|cart)\b/i.test(trimmed)
  ) {
    return true;
  }
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
  // Sticky session: reuse cached order when the same number is already open.
  const stickyReady =
    Boolean(session.orderLookupComplete) ||
    Boolean(session.currentSessionOrder?.orderNumber) ||
    hasConfirmedOrderContext(session);
  if (stickyReady) {
    const cachedNumber = String(
      session.currentSessionOrder?.orderNumber ??
        session.currentOrderData?.order_number ??
        session.currentOrder?.orderNumber ??
        session.lastOrderStatusResult?.orderNumber ??
        "",
    );
    const requested = normalizeOrderNumber(orderNumber);
    if (
      cachedNumber &&
      (!requested || orderNumbersMatch(cachedNumber, requested))
    ) {
      const cached = session.lastOrderStatusResult;
      if (cached?.status === "found") {
        const structured =
          session.currentOrder ?? orderStatusToStructuredOrder(cached);
        if (structured) {
          return { status: "found", order: structured };
        }
      }
      if (session.currentOrder) {
        return { status: "found", order: session.currentOrder };
      }
    }
  }

  const data: OrderStatusResult = await lookupOrderStatus(orderNumber, session.callSid, {
    bypassCache: true,
  });

  if (data.status === "found") {
    const structured = orderStatusToStructuredOrder(data);
    if (!structured) {
      return { status: "api_error", message: "Order lookup returned incomplete data." };
    }
    session.currentOrder = structured;
    session.lastOrderStatusResult = data;
    runVerificationGate(session, data);
    const payload = buildActiveOrderContextFromResult(data, session);
    if (payload) {
      saveActiveOrderContext(session, payload);
    } else {
      // Ensure sticky memory even if payload shaping returns null.
      session.currentSessionOrder = {
        orderNumber: String(data.orderNumber ?? "").replace(/^#/, "").trim(),
        customerName: data.customerName,
        fulfillmentStatus: data.fulfillmentStatus,
        financialStatus: data.financialStatus,
      };
      session.orderLookupComplete = true;
      session.orderContextConfirmed = true;
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
