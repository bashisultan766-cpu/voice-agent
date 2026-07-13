/**
 * Order aggregation engine — upgrades the existing Shopify lookup path with
 * deep-fetch diagnostics, caller verification, and verified/unverified filtering.
 * Reuses getOrderStatus / getCustomerHistory / phone normalizer (no duplicate workflows).
 */
import {
  getCustomerHistory,
  type CustomerHistoryOrderSummary,
  type OrderStatusResult,
} from "./shopifyStorefrontAdapter.js";
import { lookupOrderStatus } from "../services/shopifyService.js";
import { callerMatchesAnyShopifyPhone } from "../utils/phoneNormalizer.js";
import { logger } from "../utils/logger.js";

export interface OrderAggregationDiagnostics {
  coreOrder: boolean;
  tags: boolean;
  tagList: string[];
  timeline: boolean;
  timelineEventCount: number;
  metafields: boolean;
  metafieldCount: number;
  customerHistory: boolean;
  pastOrderCount: number;
  verified: boolean;
  callerPhone: string;
  payloadAccess: "full" | "filtered";
}

export interface AggregatedOrderPayload {
  status: OrderStatusResult["status"];
  order: OrderStatusResult | null;
  past_order_history: CustomerHistoryOrderSummary[] | null;
  shipping_address: string | null;
  is_verified_caller: boolean;
  diagnostics: OrderAggregationDiagnostics;
  message?: string;
  error?: string;
  searchedNumber?: string;
}

function verificationPhones(order: OrderStatusResult): Array<string | undefined> {
  return [order.customerPhone, order.shippingPhone, order.billingPhone];
}

/** Plain diagnostic checklist required before the AI agent receives the payload. */
export function printOrderAggregationChecklist(
  orderLabel: string,
  diagnostics: OrderAggregationDiagnostics,
): void {
  const lines = [
    `[SYSTEM START] Fetching Order ${orderLabel}...`,
    diagnostics.coreOrder
      ? "[SUCCESS] Core Order Data retrieved."
      : "[FAIL] Core Order Data missing.",
    diagnostics.tags
      ? `[SUCCESS] Tags retrieved (Tags: ${diagnostics.tagList.join(", ") || "none"}).`
      : "[WARN] Tags not retrieved (empty or unavailable).",
    diagnostics.timeline
      ? `[SUCCESS] Timeline/Events retrieved (Found ${diagnostics.timelineEventCount} comments/notes).`
      : "[WARN] Timeline/Events empty or unavailable.",
    diagnostics.metafields
      ? `[SUCCESS] Metafields retrieved (Found ${diagnostics.metafieldCount}).`
      : "[WARN] Metafields empty or unavailable.",
    diagnostics.customerHistory
      ? `[SUCCESS] Customer Order History retrieved (Found ${diagnostics.pastOrderCount} past orders).`
      : "[WARN] Customer Order History not retrieved.",
    diagnostics.verified
      ? `[VERIFICATION] Caller Phone (${diagnostics.callerPhone || "unknown"}) MATCHES Order Phone. Status: VERIFIED.`
      : `[VERIFICATION] Caller Phone (${diagnostics.callerPhone || "unknown"}) does NOT match Order Phone. Status: UNVERIFIED.`,
    diagnostics.payloadAccess === "full"
      ? "[PAYLOAD GENERATED] Full access granted."
      : "[PAYLOAD GENERATED] Filtered access — shipping_address and past_order_history redacted.",
  ];

  for (const line of lines) {
    console.log(line);
  }

  logger.info("order_aggregation_checklist", {
    orderLabel,
    ...diagnostics,
  });
}

/**
 * Fetch deep order data, verify the caller phone, attach past order history,
 * print the diagnostic checklist, and return a privacy-filtered payload.
 */
export async function aggregateOrderForCaller(
  orderNumber: string,
  callerPhone: string,
  callSid = "fulfillment",
): Promise<AggregatedOrderPayload> {
  const orderLabel = orderNumber.trim().startsWith("#")
    ? orderNumber.trim()
    : `#${orderNumber.trim()}`;

  const order = await lookupOrderStatus(orderNumber, callSid, { bypassCache: true });

  if (order.status !== "found") {
    const diagnostics: OrderAggregationDiagnostics = {
      coreOrder: false,
      tags: false,
      tagList: [],
      timeline: false,
      timelineEventCount: 0,
      metafields: false,
      metafieldCount: 0,
      customerHistory: false,
      pastOrderCount: 0,
      verified: false,
      callerPhone: callerPhone || "unknown",
      payloadAccess: "filtered",
    };
    printOrderAggregationChecklist(orderLabel, diagnostics);
    return {
      status: order.status,
      order: null,
      past_order_history: null,
      shipping_address: null,
      is_verified_caller: false,
      diagnostics,
      message: order.message,
      error: order.error,
      searchedNumber: order.searchedNumber,
    };
  }

  let pastOrders: CustomerHistoryOrderSummary[] = [];
  let historyFetched = false;
  if (order.customerId) {
    const history = await getCustomerHistory(order.customerId, callSid);
    if (history.status === "found") {
      pastOrders = history.orders ?? [];
      historyFetched = true;
      order.pastOrderHistory = pastOrders;
      if (history.orderCount != null) {
        order.totalOrderCount = history.orderCount;
      }
    }
  }

  const verified = callerMatchesAnyShopifyPhone(callerPhone, verificationPhones(order));
  const tagList = order.tags ?? [];
  const timelineEventCount = order.events?.length ?? 0;
  const metafieldCount = order.metafields?.length ?? 0;

  const diagnostics: OrderAggregationDiagnostics = {
    coreOrder: true,
    tags: tagList.length > 0,
    tagList,
    timeline: timelineEventCount > 0,
    timelineEventCount,
    metafields: metafieldCount > 0,
    metafieldCount,
    customerHistory: historyFetched,
    pastOrderCount: pastOrders.length,
    verified,
    callerPhone: callerPhone || "unknown",
    payloadAccess: verified ? "full" : "filtered",
  };

  printOrderAggregationChecklist(order.orderNumber ?? orderLabel, diagnostics);

  // Unverified: keep timeline/tags/notes/status/items; redact shipping + history only.
  const filteredOrder: OrderStatusResult = { ...order };
  if (!verified) {
    filteredOrder.shippingAddress = undefined;
    filteredOrder.pastOrderHistory = undefined;
  }

  return {
    status: "found",
    order: filteredOrder,
    past_order_history: verified ? pastOrders : null,
    shipping_address: verified ? (order.shippingAddress ?? null) : null,
    is_verified_caller: verified,
    diagnostics,
  };
}
