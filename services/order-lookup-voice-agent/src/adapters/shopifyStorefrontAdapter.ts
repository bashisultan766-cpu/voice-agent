/**
 * Shopify GraphQL fulfillment adapter for SureShot Bookstore voice agent.
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
  normalizeSearchText,
  rankBySearchScore,
  rankLiveProducts,
  scoreTitleMatch,
  tokenize,
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
  buildTitleExpansionQueries,
  buildTitleSegmentFallbackQueries,
  buildTitleTruthQueries,
} from "../tools/shopifyTruthSearch.js";
import {
  parseDeepOrderData,
  type DeepOrderGraphqlNode,
} from "../utils/orderDataParser.js";
import { isPhysicalBookLineItem } from "../utils/productLineItems.js";
import { extractTrackingInfo, isValidTrackingNumber } from "./orderFieldExtractors.js";
import { enrichOrderNodeTimeline } from "./shopifyOrderTimeline.js";
import { parseVariantGid, toProductGid } from "../utils/shopifyGid.js";
import { normalizeShopifyUnitPrice } from "../utils/shopifyMoney.js";
import { extractSpokenCatalogPrice } from "../agents/catalogShoppingIntent.js";

type MappedProduct = ReturnType<typeof mapGqlProduct>;
type CatalogVariant = MappedProduct["variants"][number];

function parseVariantPriceAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function selectPrimaryVariant(
  product: MappedProduct,
  options?: { preferredPrice?: number | null },
): CatalogVariant | undefined {
  const variants = product.variants ?? [];
  if (!variants.length) return undefined;
  const inStock = variants.filter((v) => v.inStock);
  const pool = inStock.length ? inStock : variants;

  if (options?.preferredPrice != null) {
    return [...pool].sort((a, b) => {
      const aDiff = Math.abs(
        (parseVariantPriceAmount(a.price) ?? Number.POSITIVE_INFINITY) - options.preferredPrice!,
      );
      const bDiff = Math.abs(
        (parseVariantPriceAmount(b.price) ?? Number.POSITIVE_INFINITY) - options.preferredPrice!,
      );
      if (aDiff !== bDiff) return aDiff - bDiff;
      return (
        (parseVariantPriceAmount(a.price) ?? Number.POSITIVE_INFINITY) -
        (parseVariantPriceAmount(b.price) ?? Number.POSITIVE_INFINITY)
      );
    })[0];
  }

  return [...pool].sort(
    (a, b) =>
      (parseVariantPriceAmount(a.price) ?? Number.POSITIVE_INFINITY) -
      (parseVariantPriceAmount(b.price) ?? Number.POSITIVE_INFINITY),
  )[0];
}

function rankTitleCandidates(
  a: MappedProduct,
  b: MappedProduct,
  query: string,
  preferredPrice?: number | null,
): number {
  const aStock = a.variants.some((v) => v.inStock) ? 1 : 0;
  const bStock = b.variants.some((v) => v.inStock) ? 1 : 0;
  if (bStock !== aStock) return bStock - aStock;

  const aExact = isExactTitleMatch(a.title, query) ? 1 : 0;
  const bExact = isExactTitleMatch(b.title, query) ? 1 : 0;
  if (bExact !== aExact) return bExact - aExact;
  if (preferredPrice != null) {
    const aVariant = selectPrimaryVariant(a, { preferredPrice });
    const bVariant = selectPrimaryVariant(b, { preferredPrice });
    const aDiff = Math.abs(
      (parseVariantPriceAmount(aVariant?.price) ?? Number.POSITIVE_INFINITY) - preferredPrice,
    );
    const bDiff = Math.abs(
      (parseVariantPriceAmount(bVariant?.price) ?? Number.POSITIVE_INFINITY) - preferredPrice,
    );
    if (aDiff !== bDiff) return aDiff - bDiff;
  }
  return scoreTitleMatch(b.title, query) - scoreTitleMatch(a.title, query);
}

function productHasStock(product: MappedProduct): boolean {
  return product.variants.some((v) => v.inStock);
}

/** High-confidence in-stock title hit — safe to stop further GraphQL fan-out. */
function isStrongInStockTitleHit(
  product: MappedProduct,
  query: string,
): boolean {
  if (!productHasStock(product)) return false;
  if (isExactTitleMatch(product.title, query)) return true;
  return scoreTitleMatch(product.title, query) >= 5;
}

function pickBestTitleCandidate(
  products: MappedProduct[],
  query: string,
  preferredPrice?: number | null,
): MappedProduct[] {
  return [...products].sort((a, b) => rankTitleCandidates(a, b, query, preferredPrice));
}

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
  /** Cancellation cause from Shopify cancelReason or refund timeline. */
  cancelReason?: string;
  /** Product subtotal before shipping (books only). */
  subtotalAmount?: string;
  totalAmount?: string;
  shippingFee?: string;
  totalTax?: string;
  totalDiscounts?: string;
  itemCount?: number;
  lineItems?: Array<{ title: string; quantity: number; price?: string }>;
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
  /** Registered Shopify customer phone — used for caller-ID verification. */
  customerPhone?: string;
  /** Shipping address phone on the order — secondary verification field. */
  shippingPhone?: string;
  /** Billing address phone on the order — tertiary verification field. */
  billingPhone?: string;
  /** Shopify Customer GID — required for order history tool. */
  customerId?: string;
  /** Formatted shipping address on the order. */
  shippingAddress?: string;
  /** Lifetime order count for the Shopify customer. */
  totalOrderCount?: number;
  /** Order tags from Shopify Admin. */
  tags?: string[];
  /** Origin channel / app source (e.g. shopify_draft_order). */
  sourceName?: string;
  channelName?: string;
  publicationName?: string;
  /** True when channel/source/tags indicate a draft-order origin. */
  isDraftOrderOrigin?: boolean;
  /** Custom attributes key/value pairs. */
  customAttributes?: Array<{ key: string; value: string }>;
  /** Structured transactions including manual payment / account deposit receipts. */
  transactions?: Array<Record<string, unknown>>;
}

export interface BookCatalogMatch {
  bookName: string;
  price: string;
  inStock: boolean;
  quantity: number;
  productId?: string;
  variantId?: string;
  exactMatch: boolean;
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
  /** Up to 5 ranked title matches (volumes/variants) for fuzzy catalog search. */
  similarMatches?: BookCatalogMatch[];
  message?: string;
}

export interface CustomerHistoryOrderSummary {
  orderNumber: string;
  monthYear: string;
  totalAmount: string;
  status: string;
  /** Comma-separated book titles only — no SKUs or variant IDs. */
  items: string;
}

export interface CustomerHistoryResult {
  status: AdapterStatus;
  customerId?: string;
  orders?: CustomerHistoryOrderSummary[];
  orderCount?: number;
  message?: string;
  error?: string;
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
        tags
        sourceName
        publication {
          name
        }
        displayFulfillmentStatus
        displayFinancialStatus
        cancelledAt
        cancelReason
        email
        phone
        shippingAddress {
          name
          address1
          address2
          city
          provinceCode
          zip
          country
          phone
        }
        billingAddress {
          phone
        }
        customer {
          id
          firstName
          lastName
          email
          phone
          numberOfOrders
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
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
        customAttributes {
          key
          value
        }
        paymentGatewayNames
        refunds(first: 5) {
          note
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
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
        events(first: 100) {
          edges {
            node {
              __typename
              ... on BasicEvent {
                message
                action
                createdAt
              }
              ... on CommentEvent {
                message
                createdAt
                author {
                  name
                }
              }
            }
          }
        }
        transactions(first: 40) {
          id
          kind
          status
          gateway
          formattedGateway
          processedAt
          accountNumber
          manualPaymentGateway
          receiptJson
          paymentDetails {
            ... on CardPaymentDetails {
              company
              number
            }
          }
          amountSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        totalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
}`;

const DEFAULT_UNFULFILLED_SHIP_DAYS = 3;

async function lookupOrdersGraphql(
  query: string,
  variables: { query: string; first: number },
): Promise<{ orders: { edges: Array<{ node: GqlOrderNode }> } }> {
  return shopifyGraphql<{ orders: { edges: Array<{ node: GqlOrderNode }> } }>(
    LOOKUP_ORDER_QUERY,
    variables,
  );
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

  for (const fulfillment of fulfillments) {
    for (const tracking of fulfillment.trackingInfo ?? []) {
      if (tracking.number && isValidTrackingNumber(tracking.number)) {
        return fulfillment;
      }
    }
  }

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
    cancelReason: parsed.cancelReason,
    refundAmount: parsed.refundAmount,
    refundDate: parsed.refundDate,
    refundNotificationEmail: parsed.refundNotificationEmail,
    refundEmail: parsed.refundNotificationEmail,
    orderConfirmationEmail: parsed.orderConfirmationEmail,
    events: parsed.events.length ? parsed.events : undefined,
    subtotalAmount: parsed.subtotalAmount,
    totalAmount: parsed.totalAmount,
    shippingFee: parsed.shippingFee,
    totalTax: parsed.totalTax,
    totalDiscounts: parsed.totalDiscounts,
    itemCount: parsed.itemCount || undefined,
    lineItems: parsed.lineItems.length ? parsed.lineItems : undefined,
    orderNote: parsed.orderNote ?? (node.note?.trim() || undefined),
    tags: parsed.tags,
    sourceName: parsed.sourceName,
    channelName: parsed.channelName,
    publicationName: parsed.publicationName,
    isDraftOrderOrigin: parsed.isDraftOrderOrigin,
    customAttributes: parsed.customAttributes,
    transactions: parsed.transactions,
    cardLast4: parsed.cardLast4,
    cardBrand: parsed.cardBrand,
    paymentGateway: parsed.paymentGateway,
    customerPhone: parsed.customerPhone,
    shippingPhone: parsed.shippingPhone,
    billingPhone: parsed.billingPhone,
    customerId: parsed.customerId,
    shippingAddress: parsed.shippingAddress,
    totalOrderCount: parsed.totalOrderCount,
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
  options?: {
    /**
     * After each sequential query, inspect accumulated nodes.
     * Return true to stop further Shopify calls (stop-on-first-strong-hit).
     */
    shouldStop?: (nodes: GqlProductNode[]) => boolean;
  },
): Promise<{ nodes: GqlProductNode[]; hadErrors: boolean; stoppedEarly: boolean }> {
  const unique = [...new Set(queries.filter(Boolean))];
  const nodes: GqlProductNode[] = [];
  let hadErrors = false;
  let stoppedEarly = false;

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
      if (options?.shouldStop?.(dedupeGqlProductNodes(nodes))) {
        stoppedEarly = true;
        break;
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

  return { nodes: dedupeGqlProductNodes(nodes), hadErrors, stoppedEarly };
}

function productToCatalogMatch(
  product: MappedProduct,
  exactMatch: boolean,
  preferredPrice?: number | null,
): BookCatalogMatch {
  const primaryVariant = selectPrimaryVariant(product, { preferredPrice });
  const quantity = product.variants.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0);
  const inStock = product.variants.some((v) => v.inStock);
  const variantGid = parseVariantGid(primaryVariant?.id ?? "") ?? undefined;

  return {
    bookName: product.title,
    price: primaryVariant?.price ?? "0",
    inStock,
    quantity,
    productId: toProductGid(product.id),
    variantId: variantGid,
    exactMatch,
  };
}

function toBookResult(
  product: MappedProduct,
  status: AdapterStatus = "found",
  meta?: {
    exactMatch?: boolean;
    queriedTitle?: string;
    similarMatches?: BookCatalogMatch[];
    preferredPrice?: number | null;
  },
): BookAvailabilityResult {
  const primaryVariant = selectPrimaryVariant(product, {
    preferredPrice: meta?.preferredPrice,
  });
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
    similarMatches: meta?.similarMatches,
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

function dedupeGqlProductNodes(nodes: GqlProductNode[]): GqlProductNode[] {
  const seen = new Set<string>();
  const out: GqlProductNode[] = [];
  for (const node of nodes) {
    if (!node.id || seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function isExactTitleMatch(title: string, query: string): boolean {
  if (scoreTitleMatch(title, query) >= 10) return true;

  const normalizedTitle = normalizeSearchText(title);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return false;

  if (normalizedTitle.includes(normalizedQuery)) return true;

  const queryTokens = tokenize(query);
  if (queryTokens.length >= 2) {
    const allTokensPresent = queryTokens.every((token) => normalizedTitle.includes(token));
    if (allTokensPresent && scoreTitleMatch(title, query) >= 3) return true;
  }

  return false;
}

const CUSTOMER_HISTORY_QUERY = `query CustomerOrderHistory($id: ID!, $first: Int!) {
  customer(id: $id) {
    id
    numberOfOrders
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          displayFulfillmentStatus
          displayFinancialStatus
          totalPriceSet {
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
        }
      }
    }
  }
}`;

/** Readable month/year for VIP order-history narration (e.g. "April 2026"). */
export function formatOrderMonthYear(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function mapHistoryOrderStatus(
  displayFinancialStatus?: string,
  displayFulfillmentStatus?: string,
): string {
  const financial = (displayFinancialStatus ?? "").toUpperCase();
  if (financial.includes("REFUND")) return "Refunded";
  const fulfillment = displayFulfillmentStatus?.trim();
  if (fulfillment) return fulfillment;
  return "Unknown";
}

export function compressHistoryLineItems(
  lineItemEdges?: Array<{ node?: { title?: string; quantity?: number } }>,
): string {
  const titles: string[] = [];
  for (const edge of lineItemEdges ?? []) {
    const title = edge.node?.title?.trim();
    if (!title || !isPhysicalBookLineItem(title)) continue;
    const qty = edge.node?.quantity ?? 1;
    titles.push(qty > 1 ? `${title} x${qty}` : title);
  }
  return titles.join(", ");
}

export interface RawCustomerHistoryOrderNode {
  name?: string;
  createdAt?: string;
  displayFulfillmentStatus?: string;
  displayFinancialStatus?: string;
  totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  lineItems?: {
    edges?: Array<{ node?: { title?: string; quantity?: number } }>;
  };
}

/** Compress Shopify order edges into a token-light timeline for the LLM. */
export function minifyCustomerHistoryOrders(
  edges: Array<{ node?: RawCustomerHistoryOrderNode }> | undefined,
): CustomerHistoryOrderSummary[] {
  const orders: CustomerHistoryOrderSummary[] = [];
  for (const edge of edges ?? []) {
    const node = edge.node;
    if (!node?.name || !node.createdAt) continue;

    orders.push({
      orderNumber: node.name.startsWith("#") ? node.name : `#${node.name}`,
      monthYear: formatOrderMonthYear(node.createdAt),
      totalAmount: formatHistoryMoney(node.totalPriceSet?.shopMoney),
      status: mapHistoryOrderStatus(node.displayFinancialStatus, node.displayFulfillmentStatus),
      items: compressHistoryLineItems(node.lineItems?.edges),
    });
  }
  return orders;
}

function isCustomerGid(value: string): boolean {
  return /^gid:\/\/shopify\/Customer\/\d+$/i.test(value.trim());
}

function formatHistoryMoney(money?: { amount?: string; currencyCode?: string }): string {
  if (!money?.amount) return "0.00 USD";
  return `${money.amount} ${money.currencyCode ?? "USD"}`;
}

/**
 * Fetch recent order history for a verified Shopify customer.
 */
export async function getCustomerHistory(
  customerId: string,
  callSid = "fulfillment",
  limit = 15,
): Promise<CustomerHistoryResult> {
  const gid = customerId.trim();
  if (!gid || !isCustomerGid(gid)) {
    return {
      status: "invalid_format",
      message: "A valid Shopify customer ID is required.",
    };
  }

  const first = Math.min(Math.max(1, limit), 15);

  try {
    const result = await runWithGuard(callSid, "customer_history", async () => {
      const data = await shopifyGraphql<{
        customer?: {
          id?: string;
          numberOfOrders?: number;
          orders?: {
            edges?: Array<{
              node?: {
                name?: string;
                createdAt?: string;
                totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
                lineItems?: {
                  edges?: Array<{
                    node?: {
                      title?: string;
                      quantity?: number;
                      originalUnitPriceSet?: {
                        shopMoney?: { amount?: string; currencyCode?: string };
                      };
                    };
                  }>;
                };
              };
            }>;
          };
        };
      }>(CUSTOMER_HISTORY_QUERY, { id: gid, first });

      const customer = data.customer;
      if (!customer?.id) {
        return {
          status: "not_found" as const,
          message: "Customer not found in Shopify.",
        };
      }

      const orders = minifyCustomerHistoryOrders(customer.orders?.edges);

      return {
        status: "found" as const,
        customerId: customer.id,
        orderCount: customer.numberOfOrders ?? orders.length,
        orders,
      };
    });

    return result;
  } catch (err) {
    return adapterFailureFromError(err, "shopify_customer_history_failed", {
      customerId: gid,
    });
  }
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
 * Fuzzy title search — sequential queries, stop on first strong in-stock hit.
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
      const preferredPrice = extractSpokenCatalogPrice(q);

      const strongHitStop = (gqlNodes: GqlProductNode[]): boolean => {
        const products = gqlNodes.map((n) => mapGqlProduct(n));
        const ranked = pickBestTitleCandidate(products, q, preferredPrice);
        const top = ranked[0];
        return Boolean(top && isStrongInStockTitleHit(top, q));
      };

      const primaryQueries = buildTitleTruthQueries(q);
      let { nodes, hadErrors, stoppedEarly } = await graphqlProductsForQueries(primaryQueries, {
        shouldStop: strongHitStop,
      });

      // Total primary failure — do not fan out expansion/fallback queries.
      if (hadErrors && nodes.length === 0) {
        return { status: "system_maintenance" as const, message: "Catalog temporarily unavailable" };
      }

      if (!stoppedEarly && nodes.length < 5) {
        const expanded = await graphqlProductsForQueries(buildTitleExpansionQueries(q), {
          shouldStop: strongHitStop,
        });
        nodes = dedupeGqlProductNodes([...nodes, ...expanded.nodes]);
        hadErrors = hadErrors || expanded.hadErrors;
        stoppedEarly = stoppedEarly || expanded.stoppedEarly;
      }

      let products = nodes.map((n) => mapGqlProduct(n));
      let ranked = rankBySearchScore(products, q, 0.5);
      let rankedList = pickBestTitleCandidate(
        ranked.length ? ranked : rankLiveProducts(products, q),
        q,
        preferredPrice,
      );

      if (!rankedList.length || !rankedList.some((p) => productHasStock(p) && isStrongInStockTitleHit(p, q))) {
        if (!stoppedEarly && !rankedList.length) {
          const fallback = await graphqlProductsForQueries(buildTitleSegmentFallbackQueries(q), {
            shouldStop: strongHitStop,
          });
          nodes = dedupeGqlProductNodes([...nodes, ...fallback.nodes]);
          hadErrors = hadErrors || fallback.hadErrors;
          products = nodes.map((n) => mapGqlProduct(n));
          ranked = rankBySearchScore(products, q, 0.25);
          rankedList = pickBestTitleCandidate(
            ranked.length ? ranked : rankLiveProducts(products, q),
            q,
            preferredPrice,
          );
        }
      }

      if (hadErrors && nodes.length === 0) {
        return { status: "system_maintenance" as const, message: "Catalog temporarily unavailable" };
      }

      // Prefer in-stock candidates so a stocked book is never discarded for an OOS hit.
      const inStockList = rankedList.filter((p) => productHasStock(p));
      const top = inStockList[0] ?? rankedList[0];
      if (!top) {
        return { status: "not_found" as const, queriedTitle: q };
      }

      const exactMatch = isExactTitleMatch(top.title, q);
      const similarSource = inStockList.length ? inStockList : rankedList;
      const similarMatches = similarSource
        .slice(0, 5)
        .map((product) =>
          productToCatalogMatch(product, isExactTitleMatch(product.title, q), preferredPrice),
        );
      return toBookResult(top, "found", { exactMatch, queriedTitle: q, similarMatches, preferredPrice });
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
