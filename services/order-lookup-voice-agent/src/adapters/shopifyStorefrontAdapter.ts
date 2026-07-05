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
  isShopifyMaintenanceFailure,
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
  orderNumbersMatch,
} from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import {
  mapGqlProduct,
  shopifyGraphql,
  type GqlProductNode,
} from "../tools/shopifyLiveSearch.js";
import {
  buildIsbnTruthQueries,
  buildTitleTruthQueries,
} from "../tools/shopifyTruthSearch.js";
import {
  parseDeepOrderData,
  type DeepOrderGraphqlNode,
} from "../utils/orderDataParser.js";
import { extractTrackingInfo } from "./orderFieldExtractors.js";
import { enrichOrderNodeTimeline } from "./shopifyOrderTimeline.js";
import { parseVariantGid, toProductGid } from "../utils/shopifyGid.js";
import { normalizeShopifyUnitPrice } from "../utils/shopifyMoney.js";

// Re-export formatter validation for order numbers (canonical source).
export { isValidOrderNumberFormat } from "../utils/formatter.js";

/** Shared adapter result status codes. */
export type AdapterStatus =
  | "found"
  | "not_found"
  | "invalid_format"
  | "api_error"
  | "system_maintenance"
  | "throttled";

export interface OrderStatusResult {
  status: AdapterStatus;
  orderNumber?: string;
  fulfillmentStatus?: string;
  trackingUrl?: string;
  trackingNumber?: string;
  trackingCompany?: string;
  trackingStatus?: string;
  /** Days until estimated delivery (0 = delivered or shipping today). */
  estimatedDeliveryDays?: number;
  estimatedDeliveryDate?: string;
  customerName?: string;
  /** Registered Shopify customer / order contact email — never the refund notification email. */
  customerEmail?: string;
  financialStatus?: string;
  refundStatus?: string;
  refundReason?: string;
  /** Product subtotal before shipping (books only). */
  subtotalAmount?: string;
  totalAmount?: string;
  shippingFee?: string;
  itemCount?: number;
  lineItems?: Array<{ title: string; quantity: number }>;
  orderNote?: string;
  cardLast4?: string;
  cardBrand?: string;
  /** Human-readable gateway when not a card (e.g. PayPal Express Checkout). */
  paymentGateway?: string;
  /** Amount refunded (refunded orders only). */
  refundAmount?: string;
  /**
   * Exact email the refund notification was sent to (timeline/custom attributes only).
   * @deprecated Use refundNotificationEmail — kept for backward compatibility.
   */
  refundEmail?: string;
  /** Exact email the refund notification was sent to — never the order billing email. */
  refundNotificationEmail?: string;
  /** Exact email the order confirmation was sent to (timeline only). */
  orderConfirmationEmail?: string;
  /** Raw timeline event messages for LLM follow-up context. */
  events?: string[];
  /** ISO timestamp when the order was placed. */
  orderPlacedAt?: string;
  /** Refund / notification date (ISO or timeline phrase e.g. "May 28"). */
  refundDate?: string;
  message?: string;
  /** Set when Shopify returns zero matching orders. */
  error?: string;
  /** Normalized order number used in the lookup (NOT_FOUND responses). */
  searchedNumber?: string;
}

export interface BookAvailabilityResult {
  status: AdapterStatus;
  bookName?: string;
  price?: string;
  inStock?: boolean;
  quantity?: number;
  productId?: string;
  /** Shopify ProductVariant GID — required for draft order checkout. */
  variantId?: string;
  isbn?: string;
  /** False when the match is fuzzy rather than an exact title hit. */
  exactMatch?: boolean;
  queriedTitle?: string;
  message?: string;
}

export interface DraftOrderLineInput {
  quantity: number;
  variantId?: string;
  title?: string;
  originalUnitPrice?: string;
}

export interface DraftOrderResult {
  success: boolean;
  status: AdapterStatus | "failed";
  invoiceUrl?: string;
  draftOrderName?: string;
  error?: string;
  message?: string;
}

/** Build a Shopify DraftOrder line — variant GID when valid, otherwise custom line item. */
export function buildDraftOrderLinePayload(item: DraftOrderLineInput): Record<string, unknown> {
  const quantity = Math.max(1, item.quantity || 1);
  const unitPrice = normalizeShopifyUnitPrice(item.originalUnitPrice);
  const variantGid = item.variantId ? parseVariantGid(item.variantId) : null;

  if (variantGid) {
    return { variantId: variantGid, quantity };
  }

  return {
    title: (item.title ?? "Book").trim() || "Book",
    quantity,
    originalUnitPrice: unitPrice,
  };
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

interface GqlOrderNode extends DeepOrderGraphqlNode {}

const LOOKUP_ORDER_QUERY = `query FulfillmentOrderLookup($query: String!, $first: Int!) {
  orders(first: $first, query: $query) {
    edges {
      node {
        id
        name
        createdAt
        processedAt
        updatedAt
        note
        displayFulfillmentStatus
        displayFinancialStatus
        email
        customer {
          firstName
          lastName
          email
        }
        currentSubtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
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
        lineItems(first: 50) {
          edges {
            node {
              title
              quantity
            }
          }
        }
        customAttributes {
          key
          value
        }
        paymentGatewayNames
        events(first: 50) {
          edges {
            node {
              message
              createdAt
              action
              ... on BasicEvent {
                message
                action
                createdAt
              }
              ... on CommentEvent {
                message
                createdAt
              }
            }
          }
        }
        refunds(first: 5) {
          note
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          transactions(first: 5) {
            edges {
              node {
                gateway
                formattedGateway
                receiptJson
                paymentDetails {
                  ... on CardPaymentDetails {
                    company
                    number
                  }
                }
              }
            }
          }
        }
        transactions(first: 10) {
          edges {
            node {
              kind
              status
              gateway
              formattedGateway
              receiptJson
              paymentDetails {
                ... on CardPaymentDetails {
                  company
                  number
                }
              }
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

/** Fallback when enriched fields (events, customAttributes) are unavailable on the shop token/API version. */
const LOOKUP_ORDER_QUERY_MINIMAL = `query FulfillmentOrderLookupMinimal($query: String!, $first: Int!) {
  orders(first: $first, query: $query) {
    edges {
      node {
        id
        name
        createdAt
        processedAt
        updatedAt
        note
        displayFulfillmentStatus
        displayFinancialStatus
        email
        customer {
          firstName
          lastName
          email
        }
        currentSubtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
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
        lineItems(first: 50) {
          edges {
            node {
              title
              quantity
            }
          }
        }
        events(first: 50) {
          edges {
            node {
              message
              createdAt
              action
              ... on BasicEvent {
                message
                action
                createdAt
              }
              ... on CommentEvent {
                message
                createdAt
              }
            }
          }
        }
        refunds(first: 5) {
          note
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        transactions {
          kind
          status
          gateway
          formattedGateway
          receiptJson
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

function isGraphqlShapeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /shopify_graphql_error/i.test(message);
}

async function lookupOrdersGraphql(
  query: string,
  variables: { query: string; first: number },
): Promise<{ orders: { edges: Array<{ node: GqlOrderNode }> } }> {
  try {
    return await shopifyGraphql<{ orders: { edges: Array<{ node: GqlOrderNode }> } }>(
      LOOKUP_ORDER_QUERY,
      variables,
    );
  } catch (err) {
    if (!isGraphqlShapeError(err)) throw err;
    logger.warn("shopify_order_lookup_fallback_minimal_query", {
      reason: err instanceof Error ? err.message.slice(0, 120) : String(err),
    });
    return shopifyGraphql<{ orders: { edges: Array<{ node: GqlOrderNode }> } }>(
      LOOKUP_ORDER_QUERY_MINIMAL,
      variables,
    );
  }
}

function findMatchingOrderNode(
  edges: Array<{ node?: GqlOrderNode }>,
  normalized: string,
): GqlOrderNode | undefined {
  const exact = edges.find(
    (e) => e.node?.name && orderNumbersMatch(e.node.name, normalized),
  );
  return exact?.node;
}

function orderLookupQueries(orderNumber: string): string[] {
  const bare = orderNumber.replace(/^#/, "");
  const withHash = orderNumber.startsWith("#") ? orderNumber : `#${bare}`;
  const baseNumeric = bare.replace(/-[A-Za-z0-9]{1,6}$/i, "");

  const out = [
    `name:${withHash}`,
    `name:${bare}`,
    `name:${withHash}*`,
    `name:${baseNumeric}*`,
  ];

  return [...new Set(out)];
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

/** @internal Exported for unit tests — maps a GraphQL order node to voice fields. */
export function mapGqlOrderNode(node: GqlOrderNode): Omit<OrderStatusResult, "status"> {
  return mapOrderNode(node);
}

function mapOrderNode(node: GqlOrderNode): Omit<OrderStatusResult, "status"> {
  const parsed = parseDeepOrderData(node);
  const fulfillment = pickPrimaryFulfillment(node.fulfillments);
  const trackingExtract = extractTrackingInfo(node.fulfillments);
  const fulfillmentStatus =
    fulfillment?.displayStatus ??
    fulfillment?.status ??
    parsed.fulfillmentStatus ??
    "unfulfilled";

  const estimatedDeliveryDays = estimateDeliveryDays(fulfillmentStatus, fulfillment);

  const trackingNumber = trackingExtract.trackingNumber;
  const trackingCompany = trackingExtract.trackingCompany;
  const trackingStatus = trackingCompany
    ? `${trackingCompany}${trackingNumber ? ` ${trackingNumber}` : ""}`.trim()
    : trackingNumber;

  const mapped: Omit<OrderStatusResult, "status"> = {
    orderNumber: parsed.orderNumber,
    orderPlacedAt: parsed.orderPlacedAt,
    fulfillmentStatus,
    trackingUrl: trackingExtract.trackingUrl,
    trackingNumber,
    trackingCompany,
    trackingStatus,
    estimatedDeliveryDays,
    estimatedDeliveryDate: fulfillment?.estimatedDeliveryAt ?? undefined,
    customerName: parsed.customerName,
    customerEmail: parsed.customerEmail,
    financialStatus: parsed.financialStatus,
    refundStatus: parsed.isRefunded ? parsed.financialStatus : undefined,
    refundReason: parsed.refundReason,
    refundAmount: parsed.refundAmount,
    refundDate: parsed.refundDate,
    refundNotificationEmail: parsed.refundNotificationEmail,
    refundEmail: parsed.refundNotificationEmail,
    orderConfirmationEmail: parsed.orderConfirmationEmail,
    events: parsed.events.length ? parsed.events : undefined,
    subtotalAmount: parsed.subtotalAmount,
    totalAmount: parsed.totalAmount,
    shippingFee: parsed.shippingFee,
    itemCount: parsed.itemCount || undefined,
    lineItems: parsed.lineItems.length ? parsed.lineItems : undefined,
    orderNote: node.note?.trim() || undefined,
    cardLast4: parsed.cardLast4,
    cardBrand: parsed.cardBrand,
    paymentGateway: parsed.paymentGateway,
  };

  logger.info("shopify_order_mapped_for_tts", {
    orderNumber: mapped.orderNumber,
    orderPlacedAt: mapped.orderPlacedAt,
    customerEmail: mapped.customerEmail,
    customerName: mapped.customerName,
    cardLast4: mapped.cardLast4,
    cardBrand: mapped.cardBrand,
    refundDate: mapped.refundDate,
    refundReason: mapped.refundReason,
    refundNotificationEmail: mapped.refundNotificationEmail,
    orderConfirmationEmail: mapped.orderConfirmationEmail,
    timelineEventCount: mapped.events?.length ?? 0,
    timelineSample: mapped.events?.slice(0, 2),
    itemCount: mapped.itemCount,
  });

  if (!mapped.refundNotificationEmail && parsed.isRefunded) {
    logger.warn("shopify_refund_notification_email_missing_from_timeline", {
      orderNumber: mapped.orderNumber,
      timelineEventCount: mapped.events?.length ?? 0,
      timelineMessages: mapped.events ?? [],
      customerEmail: mapped.customerEmail,
    });
  }

  return mapped;
}

function adapterFailureFromError(
  err: unknown,
  logEvent: string,
  meta?: Record<string, unknown>,
): Pick<OrderStatusResult, "status" | "message"> {
  if (isShopifyThrottleError(err)) {
    return { status: "throttled", message: "Shopify API throttled" };
  }
  if (isShopifyMaintenanceFailure(err)) {
    return { status: "system_maintenance", message: "Catalog temporarily unavailable" };
  }
  logger.error(logEvent, {
    ...meta,
    error: err instanceof Error ? err.message : String(err),
  });
  return { status: "system_maintenance", message: "Catalog temporarily unavailable" };
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

  const variantGid =
    parseVariantGid(primaryVariant?.id ?? "") ??
    undefined;

  return {
    status,
    bookName: product.title,
    price: primaryVariant?.price ?? "0",
    inStock,
    quantity,
    productId: toProductGid(product.id),
    variantId: variantGid,
    isbn: product.isbns?.[0],
    exactMatch: meta?.exactMatch,
    queriedTitle: meta?.queriedTitle,
  };
}

const CREATE_DRAFT_ORDER_MUTATION = `
mutation CreateDraftOrder($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
      name
      invoiceUrl
      status
    }
    userErrors {
      field
      message
    }
  }
}`;

/**
 * Create a Shopify Admin draft order and return the secure invoice checkout URL.
 */
export async function createShopifyDraftOrder(
  cartItems: DraftOrderLineInput[],
  customerEmail: string,
  customerName: string,
  callSid = "checkout",
): Promise<DraftOrderResult> {
  const lineItems = cartItems
    .filter((item) => item.quantity > 0 && (item.variantId || item.title))
    .map((item) => buildDraftOrderLinePayload(item));

  if (!lineItems.length) {
    return {
      success: false,
      status: "invalid_format",
      error: "Cart is empty.",
      message: "Cart is empty.",
    };
  }

  const email = customerEmail.trim();
  if (!email) {
    return {
      success: false,
      status: "invalid_format",
      error: "Customer email is required.",
      message: "Customer email is required.",
    };
  }

  try {
    return await runWithGuard(callSid, "draft_order_create", async () => {
      const data = await shopifyGraphql<{
        draftOrderCreate: {
          draftOrder: { id: string; name: string; invoiceUrl: string; status: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(CREATE_DRAFT_ORDER_MUTATION, {
        input: {
          lineItems,
          email,
          note: customerName.trim()
            ? `Voice order for ${customerName.trim()}`
            : "Voice agent checkout",
        },
      });

      const errors = data.draftOrderCreate?.userErrors ?? [];
      if (errors.length > 0) {
        const errorMessage = errors[0]?.message ?? "Could not create checkout link.";
        logger.warn("shopify_draft_order_user_errors", { message: errorMessage });
        return {
          success: false,
          status: "failed",
          error: errorMessage,
          message: errorMessage,
        };
      }

      const draft = data.draftOrderCreate?.draftOrder;
      if (!draft?.invoiceUrl) {
        const errorMessage = "Draft order created without invoice URL.";
        return {
          success: false,
          status: "failed",
          error: errorMessage,
          message: errorMessage,
        };
      }

      return {
        success: true,
        status: "found",
        invoiceUrl: draft.invoiceUrl,
        draftOrderName: draft.name,
      };
    });
  } catch (err) {
    if (isShopifyThrottleError(err)) {
      return {
        success: false,
        status: "throttled",
        error: "Shopify is busy. Please try again shortly.",
        message: "Shopify is busy. Please try again shortly.",
      };
    }
    const failure = adapterFailureFromError(err, "shopify_draft_order_failed", {
      callSid: callSid.slice(0, 8),
    });
    return {
      success: false,
      status: failure.status,
      error: failure.message,
      message: failure.message,
    };
  }
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
        const data = await lookupOrdersGraphql(query, { query, first: 5 });

        const edges = data.orders?.edges ?? [];
        const node = findMatchingOrderNode(edges, normalized);

        if (node) {
          const enriched = await enrichOrderNodeTimeline(node);
          return { status: "found" as const, ...mapOrderNode(enriched) };
        }
      }
      return {
        status: "not_found" as const,
        searchedNumber: normalized,
        error: "No exact match found in Shopify.",
      };
    });

    return result;
  } catch (err) {
    return adapterFailureFromError(err, "shopify_order_status_failed", {
      orderNumber: normalized,
    });
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
        return { status: "system_maintenance" as const, message: "Catalog temporarily unavailable" };
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
    return adapterFailureFromError(err, "shopify_isbn_search_failed", { isbn: normalized });
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
        return { status: "system_maintenance" as const, message: "Catalog temporarily unavailable" };
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
    return adapterFailureFromError(err, "shopify_title_search_failed", { title: q });
  }
}

/** Parse GraphQL error payload — exposed for unit tests. */
export function parseGraphqlThrottle(errors: unknown): ShopifyThrottledError | null {
  return parseShopifyGraphqlErrors(errors);
}
