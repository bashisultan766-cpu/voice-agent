import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { extractLast4, redactShopifyPayload } from "../utils/security.js";
import type { OrderLookupResult, StructuredOrder } from "../types/order.js";
import { isPhysicalBookLineItem } from "../utils/productLineItems.js";
import { isValidOrderNumberFormat, normalizeOrderNumber } from "../utils/formatter.js";

interface CacheEntry {
  expiresAt: number;
  value: OrderLookupResult;
}

const cache = new Map<string, CacheEntry>();

interface ShopifyMoney {
  amount?: string;
  currency_code?: string;
}

interface ShopifyLineItem {
  name?: string;
  title?: string;
  quantity?: number;
}

interface ShopifyRefund {
  note?: string;
  user_id?: number;
  refund_line_items?: Array<{ line_item?: ShopifyLineItem }>;
  transactions?: Array<{
    payment_details?: { credit_card_number?: string; credit_card_company?: string };
    receipt?: { payment_method_details?: { card?: { last4?: string; brand?: string } } };
  }>;
}

interface ShopifyOrder {
  id?: number;
  name?: string;
  email?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  total_price?: string;
  total_shipping_price_set?: { shop_money?: ShopifyMoney };
  subtotal_price?: string;
  currency?: string;
  customer?: { first_name?: string; last_name?: string; email?: string };
  line_items?: ShopifyLineItem[];
  refunds?: ShopifyRefund[];
  payment_gateway_names?: string[];
  billing_address?: { name?: string };
  note_attributes?: Array<{ name?: string; value?: string }>;
}

function shopifyBaseUrl(): string {
  const cfg = getConfig();
  const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}`;
}

function authHeaders(): Record<string, string> {
  return {
    "X-Shopify-Access-Token": getConfig().SHOPIFY_ADMIN_ACCESS_TOKEN,
    "Content-Type": "application/json",
  };
}

async function shopifyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const res = await fetch(`${shopifyBaseUrl()}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers ?? {}) },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn("shopify_api_error", {
        status: res.status,
        path,
        body: body.slice(0, 200),
      });
      throw new Error(`shopify_http_${res.status}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
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

function formatMoney(amount: string | undefined, currency: string | undefined): string {
  const amt = (amount ?? "0").trim();
  const cur = (currency ?? "USD").trim();
  return `${amt} ${cur}`;
}

function customerName(order: ShopifyOrder): string {
  const customer = order.customer;
  if (customer?.first_name || customer?.last_name) {
    return `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim();
  }
  return (order.billing_address?.name ?? "").trim();
}

function isProcessingFee(name: string): boolean {
  return !isPhysicalBookLineItem(name);
}

function mapLineItems(items: ShopifyLineItem[] | undefined): StructuredOrder["products"] {
  return (items ?? [])
    .filter((item) => {
      const name = item.name ?? item.title ?? "";
      return name && !isProcessingFee(name);
    })
    .map((item) => ({
      name: (item.name ?? item.title ?? "Item").trim(),
      quantity: Number(item.quantity ?? 1),
    }));
}

function refundReason(order: ShopifyOrder): string | undefined {
  for (const refund of order.refunds ?? []) {
    const note = (refund.note ?? "").trim();
    if (note && !/processing fee/i.test(note)) return note;
  }

  for (const attr of order.note_attributes ?? []) {
    const name = (attr.name ?? "").toLowerCase();
    if (name.includes("refund") && name.includes("reason") && attr.value) {
      return attr.value.trim();
    }
  }

  return undefined;
}

function refundEmail(order: ShopifyOrder): string | undefined {
  for (const attr of order.note_attributes ?? []) {
    const name = (attr.name ?? "").toLowerCase();
    if ((name.includes("refund") && name.includes("email")) || name === "refund_email") {
      return (attr.value ?? "").trim() || undefined;
    }
  }
  return (order.email ?? order.customer?.email ?? "").trim() || undefined;
}

function paymentLast4(order: ShopifyOrder): { last4?: string; brand?: string } {
  for (const refund of order.refunds ?? []) {
    for (const tx of refund.transactions ?? []) {
      const details = tx.payment_details;
      const receiptCard = tx.receipt?.payment_method_details?.card;
      const last4 =
        extractLast4(details?.credit_card_number) ??
        extractLast4(receiptCard?.last4);
      if (last4) {
        return {
          last4,
          brand: details?.credit_card_company ?? receiptCard?.brand,
        };
      }
    }
  }
  return {};
}

function isRefunded(order: ShopifyOrder): boolean {
  const fin = (order.financial_status ?? "").toLowerCase();
  if (fin.includes("refund") || fin === "voided") return true;
  return Boolean(order.refunds?.length);
}

function mapShopifyOrder(order: ShopifyOrder): StructuredOrder {
  const products = mapLineItems(order.line_items);
  const productCount = products.reduce((sum, p) => sum + p.quantity, 0);
  const shippingMoney = order.total_shipping_price_set?.shop_money;
  const refunded = isRefunded(order);
  const payment = paymentLast4(order);

  return {
    orderNumber: order.name ?? "",
    customerName: customerName(order),
    productCount: productCount || products.length,
    products,
    totalAmount: formatMoney(order.total_price, order.currency),
    shippingFee: formatMoney(shippingMoney?.amount, shippingMoney?.currency_code ?? order.currency),
    fulfillmentStatus: order.fulfillment_status ?? "unfulfilled",
    financialStatus: order.financial_status ?? "unknown",
    refund: {
      refunded,
      reason: refunded ? refundReason(order) : undefined,
      refundEmail: refunded ? refundEmail(order) : undefined,
    },
    payment: {
      cardLast4: payment.last4,
      cardBrand: payment.brand,
    },
  };
}

async function findOrderByName(orderNumber: string): Promise<ShopifyOrder | null> {
  const bare = orderNumber.replace(/^#/, "");
  const queries = [`name=${encodeURIComponent(orderNumber)}`, `name=${encodeURIComponent(bare)}`];

  for (const query of queries) {
    const data = await shopifyFetch<{ orders: ShopifyOrder[] }>(`/orders.json?status=any&limit=1&${query}`);
    const order = data.orders?.[0];
    if (order) return order;
  }

  return null;
}

async function findOrderById(id: string): Promise<ShopifyOrder | null> {
  try {
    const data = await shopifyFetch<{ order: ShopifyOrder }>(`/orders/${id}.json`);
    return data.order ?? null;
  } catch {
    return null;
  }
}

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
    let order = await findOrderByName(orderNumber);
    if (!order) {
      const bare = orderNumber.replace(/^#/, "");
      if (/^\d+$/.test(bare)) {
        order = await findOrderById(bare);
      }
    }

    if (!order) {
      const result: OrderLookupResult = { status: "not_found" };
      cacheSet(cacheKey, result);
      return result;
    }

    const structured = mapShopifyOrder(order);
    const result: OrderLookupResult = { status: "found", order: structured };
    cacheSet(cacheKey, result);

    logger.info("shopify_order_found", {
      orderNumber: structured.orderNumber,
      productCount: structured.productCount,
      refunded: structured.refund.refunded,
      payload: redactShopifyPayload({ order }),
    });

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
