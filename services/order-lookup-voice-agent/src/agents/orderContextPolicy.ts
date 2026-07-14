/**
 * Order context is only actionable after an explicit order-number lookup this call.
 * Sticky session order lives in `sessionOrderContext` (disclosure-safe OrderView) —
 * raw Shopify OrderStatusResult never leaks into shared SessionState.
 */
import { TRACKING_REQUEST_RE } from "./trackingIntent.js";
import { lookupOrderForCaller } from "./orderLookupService.js";
import type { CallSession, OrderLookupResult, StructuredOrder } from "../types/order.js";
import { buildOrderView, ORDER_DISCLOSURE_POLICY_VERSION } from "./orderDisclosurePolicy.js";
import { getActiveOrderContext, saveActiveOrderContext } from "./sessionManager.js";
import { orderNumbersMatch } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";

export function hasConfirmedOrderContext(session?: CallSession): boolean {
  return Boolean(
    session?.orderContextConfirmed && session.sessionOrderContext && getActiveOrderContext(session),
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
  session.sessionOrderContext = undefined;
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

/** Persist the disclosure-safe SessionOrderContext after a verified lookup. */
export function saveSessionOrderContext(
  session: CallSession,
  input: {
    orderNumber: string;
    orderView: import("./orderDisclosurePolicy.js").OrderView;
    verified: boolean;
  },
): void {
  const orderNumber = String(input.orderNumber ?? "").replace(/^#/, "").trim();
  if (!orderNumber) return;
  session.sessionOrderContext = {
    orderReferenceId: orderNumber,
    orderNumber,
    verificationLevel: input.verified ? "verified" : "unverified",
    disclosurePolicyVersion: ORDER_DISCLOSURE_POLICY_VERSION,
    orderView: input.orderView,
    fetchedAt: Date.now(),
  };
}

function structuredOrderFromView(
  view: import("./orderDisclosurePolicy.js").OrderView,
): StructuredOrder | undefined {
  const orderNumber = String(view.order_number ?? "").trim();
  if (!orderNumber) return undefined;
  return {
    orderNumber,
    customerName: String(view.customer_name ?? "").trim(),
    productCount: 0,
    products: [],
    totalAmount: String(view.totals?.total ?? ""),
    shippingFee: String(view.totals?.shipping ?? ""),
    fulfillmentStatus: String(view.fulfillment_status ?? ""),
    financialStatus: String(view.financial_status ?? ""),
    refund: { refunded: false },
    payment: {},
  };
}

/** Single Shopify lookup — persists confirmed order context for follow-up turns. */
export async function executeOrderLookupForSession(
  session: CallSession,
  orderNumber: string,
): Promise<OrderLookupResult> {
  const stickyReady =
    Boolean(session.orderLookupComplete) ||
    Boolean(session.currentSessionOrder?.orderNumber) ||
    Boolean(session.sessionOrderContext?.orderNumber) ||
    hasConfirmedOrderContext(session);
  if (stickyReady) {
    const cachedNumber = String(
      session.currentSessionOrder?.orderNumber ??
        session.sessionOrderContext?.orderNumber ??
        getActiveOrderContext(session)?.order_number ??
        session.currentOrder?.orderNumber ??
        "",
    );
    const requested = normalizeOrderNumber(orderNumber);
    if (
      cachedNumber &&
      (!requested || orderNumbersMatch(cachedNumber, requested))
    ) {
      if (session.currentOrder) {
        return { status: "found", order: session.currentOrder };
      }
      const view = session.sessionOrderContext?.orderView;
      const structured = view ? structuredOrderFromView(view) : undefined;
      if (structured) return { status: "found", order: structured };
    }
  }

  const lookup = await lookupOrderForCaller(session, orderNumber);

  if (lookup.status === "found" && lookup.orderView) {
    saveSessionOrderContext(session, {
      orderNumber: String(lookup.orderView.order_number ?? orderNumber),
      orderView: lookup.orderView,
      verified: session.isVerifiedCaller === true,
    });
    const structured =
      session.currentOrder ?? structuredOrderFromView(lookup.orderView);
    if (structured) {
      session.currentOrder = structured;
    }
    // Populate active order context from the disclosure-filtered view (never raw Shopify).
    const active: Record<string, unknown> = {
      order_number: lookup.orderView.order_number ?? "",
      customer_name: lookup.orderView.customer_name,
      fulfillment_status: lookup.orderView.fulfillment_status,
      financial_status: lookup.orderView.financial_status,
      items: lookup.orderView.items,
      subtotal_amount: lookup.orderView.totals?.subtotal,
      total_tax: lookup.orderView.totals?.tax,
      shipping_amount: lookup.orderView.totals?.shipping,
      total_amount: lookup.orderView.totals?.total,
      shipping_fee: lookup.orderView.shipping_fee ?? lookup.orderView.totals?.shipping,
      subtotal_price: lookup.orderView.subtotal_price ?? lookup.orderView.totals?.subtotal,
      payment_method: lookup.orderView.payment_method ?? null,
      order_metafields: lookup.orderView.order_metafields ?? null,
      timeline_attachments: lookup.orderView.timeline_attachments ?? [],
      tracking_available: lookup.orderView.tracking_available,
      is_verified_caller: session.isVerifiedCaller === true,
    };
    if (session.isVerifiedCaller === true) {
      active.shipping_address = lookup.orderView.shipping_address;
      active.past_order_history = lookup.orderView.past_order_history;
    }
    saveActiveOrderContext(session, active);
    if (!structured) {
      session.currentSessionOrder = {
        orderNumber: String(lookup.orderView.order_number ?? orderNumber).replace(/^#/, "").trim(),
        customerName: lookup.orderView.customer_name,
        fulfillmentStatus: lookup.orderView.fulfillment_status,
        financialStatus: lookup.orderView.financial_status,
      };
      session.orderLookupComplete = true;
      session.orderContextConfirmed = true;
    }
    return {
      status: "found",
      order:
        structured ?? {
          orderNumber: String(lookup.orderView.order_number ?? orderNumber),
          customerName: String(lookup.orderView.customer_name ?? ""),
          productCount: 0,
          products: [],
          totalAmount: "",
          shippingFee: "",
          fulfillmentStatus: String(lookup.orderView.fulfillment_status ?? ""),
          financialStatus: String(lookup.orderView.financial_status ?? ""),
          refund: { refunded: false },
          payment: {},
        },
    };
  }

  if (lookup.status === "not_found") {
    return { status: "not_found" };
  }

  if (lookup.status === "invalid_format") {
    return { status: "invalid_format", message: lookup.message ?? "Invalid order number." };
  }

  // Ensure buildOrderView is imported (kept for consumer usage in tests).
  void buildOrderView;
  return { status: "api_error", message: lookup.message ?? "Shopify API unavailable" };
}
