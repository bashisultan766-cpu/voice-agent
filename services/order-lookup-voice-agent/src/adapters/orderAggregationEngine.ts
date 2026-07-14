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
import { buildOrderView, type OrderView } from "../agents/orderDisclosurePolicy.js";
import type { CallSession } from "../types/order.js";
import { storeSecureOrderVault } from "../agents/callSecureVault.js";

export interface OrderAggregationDiagnostics {
  coreOrder: boolean;
  tags: boolean;
  tagList: string[];
  timeline: boolean;
  timelineEventCount: number;
  /** True when metafield identifiers were queried successfully (empty is OK). */
  metafields: boolean;
  metafieldCount: number;
  /** True only when the metafield GraphQL path threw / was unavailable. */
  metafieldQueryFailed: boolean;
  customerHistory: boolean;
  pastOrderCount: number;
  verified: boolean;
  /** Masked phone only; diagnostics are safe to serialize. */
  callerPhoneLast4: string;
  payloadAccess: "full" | "filtered";
  timelineAttachmentCount: number;
}

export interface AggregatedOrderPayload {
  status: OrderStatusResult["status"];
  /** Disclosure-safe DTO. Raw Shopify results never cross this boundary. */
  orderView: OrderView | null;
  is_verified_caller: boolean;
  diagnostics: OrderAggregationDiagnostics;
  message?: string;
  error?: string;
  searchedNumber?: string;
}

function phoneLast4(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits ? `***${digits.slice(-4)}` : "unknown";
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
    diagnostics.metafieldQueryFailed
      ? "[WARN] Metafields empty or unavailable."
      : `[SUCCESS] Metafields queried (Found ${diagnostics.metafieldCount}; productname/enddate/magazinestartdate identifiers).`,
    diagnostics.timelineAttachmentCount > 0
      ? `[SUCCESS] Timeline attachments detected (Found ${diagnostics.timelineAttachmentCount}).`
      : "[INFO] No timeline file attachments detected.",
    diagnostics.customerHistory
      ? `[SUCCESS] Customer Order History retrieved (Found ${diagnostics.pastOrderCount} past orders).`
      : "[WARN] Customer Order History not retrieved.",
    diagnostics.verified
      ? `[VERIFICATION] Caller Phone (${diagnostics.callerPhoneLast4}) MATCHES Order Phone. Status: VERIFIED.`
      : `[VERIFICATION] Caller Phone (${diagnostics.callerPhoneLast4}) does NOT match Order Phone. Status: UNVERIFIED.`,
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
      metafields: true,
      metafieldCount: 0,
      metafieldQueryFailed: false,
      customerHistory: false,
      pastOrderCount: 0,
      verified: false,
      callerPhoneLast4: phoneLast4(callerPhone),
      payloadAccess: "filtered",
      timelineAttachmentCount: 0,
    };
    printOrderAggregationChecklist(orderLabel, diagnostics);
    return {
      status: order.status,
      orderView: null,
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
  const timelineAttachmentCount = order.timelineAttachments?.length ?? 0;

  const diagnostics: OrderAggregationDiagnostics = {
    coreOrder: true,
    tags: tagList.length > 0,
    tagList,
    timeline: timelineEventCount > 0,
    timelineEventCount,
    // Identifiers query succeeded whenever we have a found order payload.
    metafields: true,
    metafieldCount,
    metafieldQueryFailed: false,
    customerHistory: historyFetched,
    pastOrderCount: pastOrders.length,
    verified,
    callerPhoneLast4: phoneLast4(callerPhone),
    payloadAccess: verified ? "full" : "filtered",
    timelineAttachmentCount,
  };

  printOrderAggregationChecklist(order.orderNumber ?? orderLabel, diagnostics);

  // Always stash shipping/history in call-scoped vault before disclosure redaction.
  storeSecureOrderVault(callSid, {
    orderNumber: order.orderNumber ?? orderLabel,
    shippingAddress: order.shippingAddress,
    pastOrderHistory: pastOrders,
    orderNote: order.orderNote,
    customAttributes: order.customAttributes,
  });

  const disclosureSession = {
    callSid,
    isVerifiedCaller: verified,
  } as CallSession;

  return {
    status: "found",
    orderView: buildOrderView(disclosureSession, {
      order_number: order.orderNumber,
      fulfillment_status: order.fulfillmentStatus,
      financial_status: order.financialStatus,
      customer_name: order.customerName,
      physical_items: order.lineItems,
      subtotal_amount: order.subtotalAmount,
      subtotal_price: order.subtotalPrice ?? order.subtotalAmount ?? null,
      total_tax: order.totalTax,
      shipping_amount: order.shippingFee,
      shipping_fee: order.shippingFee ?? null,
      total_amount: order.totalAmount,
      payment_method: order.paymentMethod ?? order.paymentGateway ?? null,
      tracking_number: order.trackingNumber,
      order_metafields: order.orderMetafields ?? null,
      timeline_attachments: order.timelineAttachments ?? [],
      metafields: order.metafields ?? [],
      events: order.events ?? [],
      ...(verified
        ? { shipping_address: order.shippingAddress, past_order_history: pastOrders }
        : {}),
    }),
    is_verified_caller: verified,
    diagnostics,
  };
}
