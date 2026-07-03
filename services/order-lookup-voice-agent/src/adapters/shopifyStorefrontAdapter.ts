/**
 * Shopify GraphQL fulfillment adapter for Shoshan voice agent.
 *
 * Exposes three core operations: order status, ISBN lookup, and title search.
 * Uses Shopify Admin GraphQL (same transport as catalog search) with enterprise
 * error handling for throttling, timeouts, and malformed payloads.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  isShopifyThrottleError,
  parseShopifyGraphqlErrors,
  ShopifyThrottledError,
} from "../platform/shopifyErrors.js";
import { withShopifyCircuitBreaker } from "../platform/circuitBreaker.js";
import {
  isValidIsbnFormat,
  normalizeIsbn,
  rankBySearchScore,
  rankLiveProducts,
  scoreTitleMatch,
} from "../utils/productSearchNormalize.js";
import {
  isValidOrderNumberFormat,
  normalizeOrderNumber,
} from "../utils/formatter.js";
import {
  mapGqlProduct,
  shopifyGraphql,
  type GqlProductNode,
} from "../tools/shopifyLiveSearch.js";
import {
  buildIsbnTruthQueries,
  buildTitleTruthQueries,
} from "../tools/shopifyTruthSearch.js";

// Re-export formatter validation for order numbers (canonical source).
export { isValidOrderNumberFormat } from "../utils/formatter.js";

/** Shared adapter result status codes. */
export type AdapterStatus =
  | "found"
  | "not_found"
  | "invalid_format"
  | "api_error"
  | "throttled";

export interface OrderStatusResult {
  status: AdapterStatus;
  orderNumber?: string;
  fulfillmentStatus?: string;
  trackingUrl?: string;
  trackingStatus?: string;
  /** Days until estimated delivery (0 = delivered or shipping today). */
  estimatedDeliveryDays?: number;
  estimatedDeliveryDate?: string;
  customerName?: string;
  financialStatus?: string;
  refundStatus?: string;
  refundReason?: string;
  totalAmount?: string;
  shippingFee?: string;
  itemCount?: number;
  lineItems?: Array<{ title: string; quantity: number }>;
  orderNote?: string;
  cardLast4?: string;
  cardBrand?: string;
  message?: string;
}

export interface BookAvailabilityResult {
  status: AdapterStatus;
  bookName?: string;
  price?: string;
  inStock?: boolean;
  quantity?: number;
  productId?: string;
  /** False when the match is fuzzy rather than an exact title hit. */
  exactMatch?: boolean;
  queriedTitle?: string;
  message?: string;
}

interface GqlFulfillmentNode {
  status?: string;
  displayStatus?: string;
  estimatedDeliveryAt?: string | null;
  deliveredAt?: string | null;
  trackingInfo?: Array<{
    company?: string;
    number?: string;
    url?: string;
  }>;
}

interface GqlOrderNode {
  id: string;
  name: string;
  note?: string | null;
  displayFulfillmentStatus?: string;
  displayFinancialStatus?: string;
  customer?: { firstName?: string; lastName?: string } | null;
  totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  totalShippingPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  lineItems?: {
    edges?: Array<{ node?: { title?: string; quantity?: number } }>;
  };
  refunds?: Array<{ note?: string | null }>;
  transactions?: Array<{
    gateway?: string;
    paymentDetails?: {
      company?: string;
      number?: string;
    };
  }>;
  fulfillments?: GqlFulfillmentNode[];
}

const LOOKUP_ORDER_QUERY = `query FulfillmentOrderLookup($query: String!, $first: Int!) {
  orders(first: $first, query: $query) {
    edges {
      node {
        id
        name
        note
        displayFulfillmentStatus
        displayFinancialStatus
        customer {
          firstName
          lastName
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 15) {
          edges {
            node {
              title
              quantity
            }
          }
        }
        refunds(first: 3) {
          note
        }
        transactions(first: 5) {
          gateway
          paymentDetails {
            ... on CardPaymentDetails {
              company
              number
            }
          }
        }
        fulfillments(first: 5) {
          status
          displayStatus
          estimatedDeliveryAt
          deliveredAt
          trackingInfo {
            company
            number
            url
          }
        }
      }
    }
  }
}`;

const DEFAULT_UNFULFILLED_SHIP_DAYS = 3;

function orderLookupQueries(orderNumber: string): string[] {
  const bare = orderNumber.replace(/^#/, "");
  const withHash = orderNumber.startsWith("#") ? orderNumber : `#${bare}`;
  return [`name:${withHash}`, `name:${bare}`];
}

function daysUntil(isoDate: string): number {
  const target = new Date(isoDate);
  if (Number.isNaN(target.getTime())) return DEFAULT_UNFULFILLED_SHIP_DAYS;
  const diffMs = target.getTime() - Date.now();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

function pickPrimaryFulfillment(fulfillments: GqlFulfillmentNode[] | undefined): GqlFulfillmentNode | null {
  if (!fulfillments?.length) return null;
  const withTracking = fulfillments.find((f) => f.trackingInfo?.some((t) => t.url || t.number));
  return withTracking ?? fulfillments[0] ?? null;
}

function estimateDeliveryDays(
  fulfillmentStatus: string,
  fulfillment: GqlFulfillmentNode | null,
): number {
  if (fulfillment?.deliveredAt) return 0;

  if (fulfillment?.estimatedDeliveryAt) {
    return daysUntil(fulfillment.estimatedDeliveryAt);
  }

  const status = fulfillmentStatus.toLowerCase();
  if (status.includes("fulfilled") || status.includes("shipped")) {
    return 5;
  }
  if (status.includes("partial")) {
    return DEFAULT_UNFULFILLED_SHIP_DAYS + 2;
  }
  return DEFAULT_UNFULFILLED_SHIP_DAYS;
}

function extractCardLast4(paymentNumber?: string): string | undefined {
  if (!paymentNumber) return undefined;
  const digits = paymentNumber.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

function formatMoneyAmount(
  money?: { amount?: string; currencyCode?: string },
): string | undefined {
  if (!money?.amount) return undefined;
  const code = money.currencyCode ?? "USD";
  return `${money.amount} ${code}`;
}

function customerDisplayName(
  customer?: { firstName?: string; lastName?: string } | null,
): string | undefined {
  if (!customer) return undefined;
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function mapOrderNode(node: GqlOrderNode): Omit<OrderStatusResult, "status"> {
  const fulfillment = pickPrimaryFulfillment(node.fulfillments);
  const tracking = fulfillment?.trackingInfo?.find((t) => t.url || t.number);
  const fulfillmentStatus =
    fulfillment?.displayStatus ??
    fulfillment?.status ??
    node.displayFulfillmentStatus ??
    "unfulfilled";

  const estimatedDeliveryDays = estimateDeliveryDays(fulfillmentStatus, fulfillment);

  const lineItems =
    node.lineItems?.edges
      ?.map((e) => ({
        title: e.node?.title ?? "Item",
        quantity: e.node?.quantity ?? 1,
      }))
      .filter((li) => li.title) ?? [];

  const itemCount = lineItems.reduce((sum, li) => sum + li.quantity, 0);

  const financialStatus = node.displayFinancialStatus ?? "";
  const refundNote = node.refunds?.find((r) => r.note)?.note ?? undefined;
  const isRefunded = /refund/i.test(financialStatus);

  const cardTxn = node.transactions?.find(
    (t) => t.paymentDetails?.number || t.paymentDetails?.company,
  );
  const cardLast4 = extractCardLast4(cardTxn?.paymentDetails?.number);

  return {
    orderNumber: node.name,
    fulfillmentStatus,
    trackingUrl: tracking?.url,
    trackingStatus: tracking?.company
      ? `${tracking.company}${tracking.number ? ` ${tracking.number}` : ""}`.trim()
      : undefined,
    estimatedDeliveryDays,
    estimatedDeliveryDate: fulfillment?.estimatedDeliveryAt ?? undefined,
    customerName: customerDisplayName(node.customer),
    financialStatus,
    refundStatus: isRefunded ? financialStatus : undefined,
    refundReason: isRefunded ? refundNote : undefined,
    totalAmount: formatMoneyAmount(node.totalPriceSet?.shopMoney),
    shippingFee: formatMoneyAmount(node.totalShippingPriceSet?.shopMoney),
    itemCount: itemCount || lineItems.length || undefined,
    lineItems: lineItems.length ? lineItems : undefined,
    orderNote: node.note?.trim() || undefined,
    cardLast4,
    cardBrand: cardTxn?.paymentDetails?.company ?? cardTxn?.gateway,
  };
}

async function runWithGuard<T>(
  callSid: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await withShopifyCircuitBreaker(callSid, operation, work);
  } catch (err) {
    if (isShopifyThrottleError(err)) throw err;
    throw err;
  }
}

async function graphqlProductsForQueries(
  queries: string[],
): Promise<{ nodes: GqlProductNode[]; hadErrors: boolean }> {
  const unique = [...new Set(queries.filter(Boolean))];
  const nodes: GqlProductNode[] = [];
  let hadErrors = false;

  for (const q of unique) {
    try {
      const data = await shopifyGraphql<{
        products: { edges: Array<{ node: GqlProductNode }> };
      }>(
        `query ProductFulfillmentSearch($query: String!) {
          products(first: 25, query: $query) {
            edges { node { id title handle tags vendor productType
              variants(first: 10) {
                edges { node { id sku barcode title price inventoryQuantity } }
              }
              metafields(first: 10) {
                edges { node { namespace key value } }
              }
            } }
          }
        }`,
        { query: q },
      );
      for (const edge of data.products?.edges ?? []) {
        if (edge.node) nodes.push(edge.node);
      }
    } catch (err) {
      if (isShopifyThrottleError(err)) throw err;
      hadErrors = true;
      logger.warn("shopify_fulfillment_product_query_failed", {
        query: q,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { nodes, hadErrors };
}

function toBookResult(
  product: ReturnType<typeof mapGqlProduct>,
  status: AdapterStatus = "found",
  meta?: { exactMatch?: boolean; queriedTitle?: string },
): BookAvailabilityResult {
  const primaryVariant = product.variants[0];
  const quantity = product.variants.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0);
  const inStock = product.variants.some((v) => v.inStock);

  return {
    status,
    bookName: product.title,
    price: primaryVariant?.price ?? "0",
    inStock,
    quantity,
    productId: product.id,
    exactMatch: meta?.exactMatch,
    queriedTitle: meta?.queriedTitle,
  };
}

function isExactTitleMatch(title: string, query: string): boolean {
  return scoreTitleMatch(title, query) >= 10;
}

/**
 * Query Shopify for order fulfillment status, tracking, and estimated delivery.
 */
export async function getOrderStatus(
  orderNumber: string,
  callSid = "fulfillment",
): Promise<OrderStatusResult> {
  const normalized = normalizeOrderNumber(orderNumber);
  if (!normalized || !isValidOrderNumberFormat(normalized)) {
    return {
      status: "invalid_format",
      message: "Order number must be 4 to 10 digits.",
    };
  }

  try {
    const result = await runWithGuard(callSid, "order_status", async () => {
      for (const query of orderLookupQueries(normalized)) {
        const data = await shopifyGraphql<{
          orders: { edges: Array<{ node: GqlOrderNode }> };
        }>(LOOKUP_ORDER_QUERY, { query, first: 3 });

        const edges = data.orders?.edges ?? [];
        const match = edges.find(
          (e) =>
            e.node?.name?.replace(/^#/, "") === normalized.replace(/^#/, ""),
        );

        if (match?.node) {
          return { status: "found" as const, ...mapOrderNode(match.node) };
        }
      }
      return { status: "not_found" as const };
    });

    return result;
  } catch (err) {
    if (isShopifyThrottleError(err)) {
      return { status: "throttled", message: "Shopify API throttled" };
    }
    logger.error("shopify_order_status_failed", {
      orderNumber: normalized,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "api_error", message: "Shopify API unavailable" };
  }
}

/**
 * Strict ISBN search — barcode, SKU, or ISBN metafields only.
 */
export async function searchByISBN(
  isbn: string,
  callSid = "fulfillment",
): Promise<BookAvailabilityResult> {
  const normalized = normalizeIsbn(isbn);
  if (!normalized || !isValidIsbnFormat(normalized)) {
    return {
      status: "invalid_format",
      message: "ISBN must be 10 or 13 digits.",
    };
  }

  if (getConfig().SAFE_MODE) {
    return { status: "not_found", message: "Catalog search disabled in safe mode." };
  }

  try {
    const result = await runWithGuard(callSid, "isbn_search", async () => {
      const queries = buildIsbnTruthQueries(normalized);
      const { nodes, hadErrors } = await graphqlProductsForQueries(queries);
      if (hadErrors && nodes.length === 0) {
        return { status: "api_error" as const, message: "Shopify API unavailable" };
      }
      const products = nodes.map((n) => mapGqlProduct(n));
      const ranked = rankLiveProducts(products, normalized, normalized);

      if (!ranked.length) {
        return { status: "not_found" as const };
      }

      return toBookResult(ranked[0]!);
    });

    return result;
  } catch (err) {
    if (isShopifyThrottleError(err)) {
      return { status: "throttled", message: "Shopify API throttled" };
    }
    logger.error("shopify_isbn_search_failed", {
      isbn: normalized,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "api_error", message: "Shopify API unavailable" };
  }
}

/**
 * Fuzzy title search — returns top-ranked catalog match.
 */
export async function searchByTitle(
  title: string,
  callSid = "fulfillment",
): Promise<BookAvailabilityResult> {
  const q = title.trim();
  if (!q || q.length < 2) {
    return { status: "invalid_format", message: "Please provide a book title." };
  }

  if (getConfig().SAFE_MODE) {
    return { status: "not_found", message: "Catalog search disabled in safe mode." };
  }

  try {
    const result = await runWithGuard(callSid, "title_search", async () => {
      const queries = buildTitleTruthQueries(q);
      const { nodes, hadErrors } = await graphqlProductsForQueries(queries);
      if (hadErrors && nodes.length === 0) {
        return { status: "api_error" as const, message: "Shopify API unavailable" };
      }
      const products = nodes.map((n) => mapGqlProduct(n));

      const ranked = rankBySearchScore(products, q, 0.5);
      const top = ranked[0] ?? rankLiveProducts(products, q)[0];
      if (!top) {
        return { status: "not_found" as const };
      }

      const exactMatch = isExactTitleMatch(top.title, q);
      return toBookResult(top, "found", { exactMatch, queriedTitle: q });
    });

    return result;
  } catch (err) {
    if (isShopifyThrottleError(err)) {
      return { status: "throttled", message: "Shopify API throttled" };
    }
    logger.error("shopify_title_search_failed", {
      title: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "api_error", message: "Shopify API unavailable" };
  }
}

/** Parse GraphQL error payload — exposed for unit tests. */
export function parseGraphqlThrottle(errors: unknown): ShopifyThrottledError | null {
  return parseShopifyGraphqlErrors(errors);
}
