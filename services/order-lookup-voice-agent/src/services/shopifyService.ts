import {
  getOrderStatus,
  type OrderStatusResult,
} from "../adapters/shopifyStorefrontAdapter.js";
import {
  isStableOrderLookupStatus,
  isTransientOrderLookupStatus,
  isRetriableOrderLookupMiss,
} from "../agents/orderLookupWorkflow.js";
import { getConfig } from "../config.js";
import {
  getShopifyAdminAccessToken,
  resetShopifyAccessTokenCacheForTests,
} from "../platform/shopifyAccessToken.js";
import { logger } from "../utils/logger.js";
import type { OrderLookupResult, StructuredOrder } from "../types/order.js";
import { isValidOrderNumberFormat, normalizeOrderNumber } from "../utils/formatter.js";
import { TimeoutError, withTimeout } from "../utils/promiseTimeout.js";

/** Dynamic Admin API token (Client Credentials Grant or static fallback). */
export async function getAccessToken(): Promise<string> {
  return getShopifyAdminAccessToken();
}

export { resetShopifyAccessTokenCacheForTests };

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  // Positive hits and invalid format only — never negative not_found.
  if (value.status !== "found" && value.status !== "invalid_format") return;
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

export function clearOrderStatusCache(rawOrderNumber?: string): void {
  if (!rawOrderNumber) {
    cache.clear();
    statusCache.clear();
    return;
  }
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  if (!orderNumber) return;
  statusCache.delete(`status:${orderNumber}`);
  cache.delete(`order:${orderNumber}`);
}

/**
 * Full order status lookup — single Shopify entry point with retry and stable-only cache.
 */
export async function lookupOrderStatus(
  rawOrderNumber: string,
  callSid = "fulfillment",
  options?: { bypassCache?: boolean },
): Promise<OrderStatusResult> {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  if (!orderNumber || !isValidOrderNumberFormat(orderNumber)) {
    return {
      status: "invalid_format",
      message: "Order number must be 4 to 10 digits.",
    };
  }

  if (options?.bypassCache) {
    clearOrderStatusCache(orderNumber);
  }

  const cacheKey = `status:${orderNumber}`;
  const maxRetries = Math.max(0, getConfig().ORDER_LOOKUP_MAX_RETRIES);
  let lastResult: OrderStatusResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      clearOrderStatusCache(orderNumber);
      await delay(300 * attempt);
      logger.info("shopify_status_lookup_retry", { orderNumber, attempt });
    }

    const cached = statusCacheGet(cacheKey);
    if (cached) {
      logger.debug("shopify_status_cache_hit", { orderNumber });
      return cached;
    }

    try {
      const data = await withTimeout(
        getOrderStatus(orderNumber, callSid),
        Math.min(getConfig().SHOPIFY_TIMEOUT_MS, getConfig().TOOL_EXECUTION_TIMEOUT_MS),
        "shopify_order_lookup",
      );
      lastResult = data;

      if (isStableOrderLookupStatus(data.status)) {
        statusCacheSet(cacheKey, data);
        cacheSet(`order:${orderNumber}`, mapLookupResult(data));
        return data;
      }

      if (
        isRetriableOrderLookupMiss(data.status) &&
        attempt < maxRetries
      ) {
        clearOrderStatusCache(orderNumber);
        await delay(300 * (attempt + 1));
        logger.info("shopify_status_lookup_not_found_retry", {
          orderNumber,
          attempt: attempt + 1,
        });
        continue;
      }

      if (!isTransientOrderLookupStatus(data.status) || attempt >= maxRetries) {
        return data;
      }
    } catch (err) {
      const timedOut = err instanceof TimeoutError || /timed out/i.test(
        err instanceof Error ? err.message : String(err),
      );
      logger.error("shopify_status_lookup_failed", {
        orderNumber,
        attempt,
        timedOut,
        error: err instanceof Error ? err.message : String(err),
      });
      lastResult = {
        status: "api_error",
        message: timedOut ? "Shopify API timeout" : "Shopify API unavailable",
      };
      if (attempt >= maxRetries) {
        return lastResult;
      }
    }
  }

  return (
    lastResult ?? {
      status: "api_error",
      message: "Shopify API unavailable",
    }
  );
}

/**
 * Structured order lookup — uses lookupOrderStatus internally.
 */
export async function lookupOrder(
  rawOrderNumber: string,
  options?: { bypassCache?: boolean },
): Promise<OrderLookupResult> {
  const data = await lookupOrderStatus(rawOrderNumber, "fulfillment", options);
  return mapLookupResult(data);
}

export function clearOrderCache(): void {
  clearOrderStatusCache();
}

export { searchByTitle } from "../adapters/shopifyStorefrontAdapter.js";
