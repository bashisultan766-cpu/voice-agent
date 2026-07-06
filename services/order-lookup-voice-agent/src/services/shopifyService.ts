import { getOrderStatus, type OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type { OrderLookupResult, StructuredOrder } from "../types/order.js";
import { isValidOrderNumberFormat, normalizeOrderNumber } from "../utils/formatter.js";

interface CacheEntry {
  expiresAt: number;
  value: OrderLookupResult;
}

const cache = new Map<string, CacheEntry>();

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
 * Order lookup — uses the same GraphQL FulfillmentOrderLookup query as the voice agent.
 * No REST fallback and no alternate GraphQL query shape.
 */
export async function lookupOrder(rawOrderNumber: string): Promise<OrderLookupResult> {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  if (!orderNumber || !isValidOrderNumberFormat(orderNumber)) {
    return {
      status: "invalid_format",
      message: "Order number must be 4 to 10 digits.",
    };
  }

  const cacheKey = `order:${orderNumber}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.debug("shopify_cache_hit", { orderNumber });
    return cached;
  }

  try {
    const data = await getOrderStatus(orderNumber);
    const result = mapLookupResult(data);
    cacheSet(cacheKey, result);

    if (result.status === "found") {
      logger.info("shopify_order_found", {
        orderNumber: result.order.orderNumber,
        productCount: result.order.productCount,
        refunded: result.order.refund.refunded,
      });
    }

    return result;
  } catch (err) {
    logger.error("shopify_lookup_failed", {
      orderNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "api_error",
      message: "Shopify API unavailable",
    };
  }
}

export function clearOrderCache(): void {
  cache.clear();
}
