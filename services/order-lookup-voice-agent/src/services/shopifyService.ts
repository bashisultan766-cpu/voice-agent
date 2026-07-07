import {
  getOrderStatus,
  type OrderStatusResult,
} from "../adapters/shopifyStorefrontAdapter.js";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type { OrderLookupResult, StructuredOrder } from "../types/order.js";
import { isValidOrderNumberFormat, normalizeOrderNumber } from "../utils/formatter.js";

interface CacheEntry {
  expiresAt: number;
  value: OrderLookupResult;
}

interface StatusCacheEntry {
  expiresAt: number;
  value: OrderStatusResult;
}

const cache = new Map<string, CacheEntry>();
const statusCache = new Map<string, StatusCacheEntry>();

function cacheGet(key: string): OrderLookupResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: OrderLookupResult): void {
  const ttl = getConfig().SHOPIFY_CACHE_TTL_SECS * 1000;
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function statusCacheGet(key: string): OrderStatusResult | null {
  const entry = statusCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    statusCache.delete(key);
    return null;
  }
  return entry.value;
}

function statusCacheSet(key: string, value: OrderStatusResult): void {
  const ttl = getConfig().SHOPIFY_CACHE_TTL_SECS * 1000;
  statusCache.set(key, { value, expiresAt: Date.now() + ttl });
}

function mapFoundOrder(data: OrderStatusResult): StructuredOrder {
  const refunded =
    Boolean(data.refundReason) ||
    (data.financialStatus ?? "").toUpperCase().includes("REFUND") ||
    (data.refundStatus ?? "").toUpperCase().includes("REFUND");

  return {
    orderNumber: data.orderNumber ?? "",
    customerName: data.customerName ?? "",
    productCount: data.itemCount ?? data.lineItems?.length ?? 0,
    products: (data.lineItems ?? []).map((item) => ({
      name: item.title,
      quantity: item.quantity,
    })),
    totalAmount: data.totalAmount ?? "",
    shippingFee: data.shippingFee ?? "",
    fulfillmentStatus: data.fulfillmentStatus ?? "unfulfilled",
    financialStatus: data.financialStatus ?? "unknown",
    refund: {
      refunded,
      reason: data.refundReason ?? data.cancelReason,
      refundEmail: data.refundNotificationEmail ?? data.refundEmail,
      refundAmount: data.refundAmount,
    },
    payment: {
      cardLast4: data.cardLast4,
      cardBrand: data.cardBrand,
    },
  };
}

function mapLookupResult(data: OrderStatusResult): OrderLookupResult {
  switch (data.status) {
    case "found":
      return { status: "found" as const, order: mapFoundOrder(data) };
    case "not_found":
      return { status: "not_found" };
    case "invalid_format":
      return { status: "invalid_format", message: data.message ?? "Invalid order number." };
    case "throttled":
    case "system_maintenance":
    case "api_error":
    default:
      return {
        status: "api_error",
        message: data.message ?? "Shopify API unavailable",
      };
  }
}

/**
 * Full order status lookup — single Shopify entry point for LLM tools and adapters.
 */
export async function lookupOrderStatus(
  rawOrderNumber: string,
  callSid = "fulfillment",
): Promise<OrderStatusResult> {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  if (!orderNumber || !isValidOrderNumberFormat(orderNumber)) {
    return {
      status: "invalid_format",
      message: "Order number must be 4 to 10 digits.",
    };
  }

  const cacheKey = `status:${orderNumber}`;
  const cached = statusCacheGet(cacheKey);
  if (cached) {
    logger.debug("shopify_status_cache_hit", { orderNumber });
    return cached;
  }

  try {
    const data = await getOrderStatus(orderNumber, callSid);
    statusCacheSet(cacheKey, data);
    cacheSet(`order:${orderNumber}`, mapLookupResult(data));
    return data;
  } catch (err) {
    logger.error("shopify_status_lookup_failed", {
      orderNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "api_error",
      message: "Shopify API unavailable",
    };
  }
}

/**
 * Structured order lookup — uses lookupOrderStatus internally.
 */
export async function lookupOrder(rawOrderNumber: string): Promise<OrderLookupResult> {
  const data = await lookupOrderStatus(rawOrderNumber);
  return mapLookupResult(data);
}

export function clearOrderCache(): void {
  cache.clear();
  statusCache.clear();
}
