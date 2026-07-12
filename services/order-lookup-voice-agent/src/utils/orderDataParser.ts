/**
 * Strict order data parser — maps Shopify GraphQL nodes to typed fields
 * and builds the proactive fluent-English order summary for TTS.
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import {
  extractOrderConfirmationEmail,
  extractPaymentMethod,
  humanizeShopifyCancelReason,
  extractRefundAmount,
  extractRefundNotificationDate,
  extractRefundNotificationEmail,
  extractRefundReason,
  extractTimelineRefundReason,
  timelineEventMessages,
  summarizeTransactionForLlm,
  type OrderCustomAttribute,
  type OrderRefundNode,
  type OrderTimelineEvent,
  type OrderTransactionNode,
} from "../adapters/orderFieldExtractors.js";
import { physicalItemCount, splitLineItems } from "./productLineItems.js";
import { buildVerificationFirstOrderSpeech } from "../agents/orderLookupProtocol.js";
import { fulfillmentStatusPhrase, speakMoney } from "./formatter.js";

export interface DeepOrderGraphqlNode {
  id: string;
  name: string;
  createdAt?: string;
  processedAt?: string | null;
  updatedAt?: string;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  tags?: string[] | string | null;
  sourceName?: string | null;
  publication?: { name?: string | null } | null;
  channelInformation?: {
    channelDefinition?: { channelName?: string | null; handle?: string | null } | null;
  } | null;
  displayFulfillmentStatus?: string;
  displayFinancialStatus?: string;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  shippingAddress?: {
    name?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    provinceCode?: string | null;
    zip?: string | null;
    country?: string | null;
    phone?: string | null;
  } | null;
  billingAddress?: {
    phone?: string | null;
  } | null;
  customer?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    email?: string | null;
    phone?: string | null;
    numberOfOrders?: number;
  } | null;
  currentSubtotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  subtotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  totalShippingPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  totalTaxSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  totalDiscountsSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  customAttributes?: OrderCustomAttribute[];
  paymentGatewayNames?: string[];
  events?: {
    edges?: Array<{
      node?: OrderTimelineEvent;
    }>;
    nodes?: Array<OrderTimelineEvent | null | undefined>;
  };
  lineItems?: {
    edges?: Array<{
      node?: {
        title?: string;
        quantity?: number;
        currentQuantity?: number | null;
        unfulfilledQuantity?: number | null;
        variant?: { title?: string | null; sku?: string | null } | null;
        originalUnitPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
      };
    }>;
  };
  refunds?: OrderRefundNode[];
  /**
   * 2026-01 Admin API: Order.transactions is `[OrderTransaction!]!` (not a Connection).
   * Refund.transactions remains OrderTransactionConnection — normalized in refundTransactionNodes.
   * Legacy connection-shaped order payloads are still accepted for tests.
   */
  transactions?:
    | OrderTransactionNode[]
    | {
        edges?: Array<{
          node?: OrderTransactionNode;
        }>;
      };
  fulfillments?: Array<{
    status?: string;
    displayStatus?: string;
    estimatedDeliveryAt?: string | null;
    deliveredAt?: string | null;
    trackingInfo?: Array<{ company?: string; number?: string; url?: string }>;
  }>;
}

/** Strict typed order context — no field may be silently dropped at parse time. */
export interface ParsedOrderData {
  orderNumber: string;
  customerName?: string;
  customerEmail?: string;
  orderPlacedAt?: string;
  orderPlacedAtSpoken?: string;
  subtotalAmount?: string;
  shippingFee?: string;
  totalAmount?: string;
  totalTax?: string;
  totalDiscounts?: string;
  itemCount: number;
  lineItems: Array<{
    title: string;
    quantity: number;
    price?: string;
    variantTitle?: string;
    sku?: string;
    fulfillmentStatus?: string;
  }>;
  feeLineItems: Array<{
    title: string;
    quantity: number;
    price?: string;
    variantTitle?: string;
    sku?: string;
    fulfillmentStatus?: string;
  }>;
  isRefunded: boolean;
  refundReason?: string;
  /** Shopify cancelReason enum or timeline-derived cancellation cause. */
  cancelReason?: string;
  refundNotificationEmail?: string;
  orderConfirmationEmail?: string;
  /** Raw timeline messages — injected into LLM session memory for follow-ups. */
  events: string[];
  /** Order note / memo (often account deposits, credits, staff instructions). */
  orderNote?: string;
  tags?: string[];
  sourceName?: string;
  channelName?: string;
  publicationName?: string;
  isDraftOrderOrigin?: boolean;
  customAttributes?: Array<{ key: string; value: string }>;
  /** Structured payment / manual-mark transactions for LLM A-to-Z context. */
  transactions?: Array<Record<string, unknown>>;
  refundDate?: string;
  refundAmount?: string;
  fulfillmentStatus?: string;
  trackingStatus?: string;
  estimatedDeliveryDays?: number;
  cardLast4?: string;
  cardBrand?: string;
  paymentGateway?: string;
  financialStatus?: string;
  customerPhone?: string;
  trackingNumber?: string;
  shippingPhone?: string;
  billingPhone?: string;
  customerId?: string;
  shippingAddress?: string;
  totalOrderCount?: number;
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** Human-readable English date — e.g. "May 27th, 2022". */
export function formatOrderDateEnglish(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;

  const month = parsed.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const day = parsed.getUTCDate();
  const year = parsed.getUTCFullYear();
  return `${month} ${day}${ordinalSuffix(day)}, ${year}`;
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

function customerRegisteredEmail(node: DeepOrderGraphqlNode): string | undefined {
  const fromCustomer = node.customer?.email?.trim();
  if (fromCustomer) return fromCustomer;
  const fromOrder = node.email?.trim();
  return fromOrder || undefined;
}

function customerRegisteredPhone(node: DeepOrderGraphqlNode): string | undefined {
  const fromCustomer = node.customer?.phone?.trim();
  if (fromCustomer) return fromCustomer;
  const fromOrder = node.phone?.trim();
  return fromOrder || undefined;
}

function shippingAddressPhone(node: DeepOrderGraphqlNode): string | undefined {
  return node.shippingAddress?.phone?.trim() || undefined;
}

function billingAddressPhone(node: DeepOrderGraphqlNode): string | undefined {
  return node.billingAddress?.phone?.trim() || undefined;
}

function formatShippingAddress(
  address: DeepOrderGraphqlNode["shippingAddress"],
): string | undefined {
  if (!address) return undefined;
  const cityLine = [address.city, address.provinceCode, address.zip]
    .filter(Boolean)
    .join(", ");
  const parts = [
    address.name,
    address.address1,
    address.address2,
    cityLine,
    address.country,
  ]
    .map((part) => (part ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

function normalizeOrderTags(tags: DeepOrderGraphqlNode["tags"]): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(tags)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function detectDraftOrderOrigin(node: DeepOrderGraphqlNode): boolean {
  const source = (node.sourceName ?? "").toLowerCase();
  const channel = (
    node.channelInformation?.channelDefinition?.channelName ??
    node.channelInformation?.channelDefinition?.handle ??
    ""
  ).toLowerCase();
  const publication = (node.publication?.name ?? "").toLowerCase();
  const tags = normalizeOrderTags(node.tags).map((t) => t.toLowerCase());
  return (
    /draft/.test(source) ||
    source.includes("shopify_draft_order") ||
    /draft/.test(channel) ||
    /draft/.test(publication) ||
    tags.some((t) => t.includes("draft"))
  );
}

function timelineEvents(node: DeepOrderGraphqlNode): OrderTimelineEvent[] {
  const fromEdges = (node.events?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is NonNullable<typeof n> => Boolean(n));
  const fromNodes = (node.events?.nodes ?? []).filter(
    (n): n is NonNullable<typeof n> => Boolean(n),
  );
  const raw = fromEdges.length ? fromEdges : fromNodes;
  return raw.map((event) => {
    const authorName = event.authorName ?? event.staffName ?? null;
    return {
      message: event.message,
      action: event.action,
      createdAt: event.createdAt,
      authorName,
      staffName: authorName,
    };
  });
}

function lineItemFulfillmentStatus(
  quantity: number,
  unfulfilledQuantity: number | null | undefined,
): string {
  const unfulfilled =
    typeof unfulfilledQuantity === "number" && Number.isFinite(unfulfilledQuantity)
      ? Math.max(0, unfulfilledQuantity)
      : quantity;
  if (unfulfilled <= 0) return "fulfilled";
  if (unfulfilled < quantity) return "partial";
  return "unfulfilled";
}

export type ParsedLineItem = {
  title: string;
  quantity: number;
  price?: string;
  variantTitle?: string;
  sku?: string;
  fulfillmentStatus?: string;
};

function parseRawLineItems(node: DeepOrderGraphqlNode): ParsedLineItem[] {
  const items: ParsedLineItem[] = [];
  for (const edge of node.lineItems?.edges ?? []) {
    const title = edge.node?.title?.trim();
    if (!title) continue;
    const quantity = edge.node?.quantity ?? 1;
    const price = formatMoneyAmount(edge.node?.originalUnitPriceSet?.shopMoney);
    const variantTitle = edge.node?.variant?.title?.trim() || undefined;
    const sku = edge.node?.variant?.sku?.trim() || undefined;
    const fulfillmentStatus = lineItemFulfillmentStatus(
      quantity,
      edge.node?.unfulfilledQuantity,
    );
    items.push({
      title,
      quantity,
      ...(price ? { price } : {}),
      ...(variantTitle ? { variantTitle } : {}),
      ...(sku ? { sku } : {}),
      fulfillmentStatus,
    });
  }
  return items;
}

function parseLineItems(node: DeepOrderGraphqlNode): ParsedLineItem[] {
  return splitLineItems(parseRawLineItems(node)).physicalItems;
}

function subtotalFromNode(node: DeepOrderGraphqlNode): string | undefined {
  return (
    formatMoneyAmount(node.currentSubtotalPriceSet?.shopMoney) ??
    formatMoneyAmount(node.subtotalPriceSet?.shopMoney)
  );
}

/**
 * Normalize order-level transactions from GraphQL:
 * - Array: `[{ gateway, ... }]` (2026-01 Order.transactions)
 * - Legacy connection: `{ edges: [{ node: { gateway, ... } }] }`
 */
export function transactionNodesFromConnection(
  transactionsData: DeepOrderGraphqlNode["transactions"],
): OrderTransactionNode[] {
  if (!transactionsData) return [];
  if (Array.isArray(transactionsData)) return transactionsData;
  if (transactionsData.edges) {
    return transactionsData.edges
      .map((edge) => edge.node)
      .filter((node): node is OrderTransactionNode => node != null);
  }
  return [];
}

/**
 * Map a deep-fetch GraphQL order node into a strictly typed object.
 * Guarantees customer email, placement date, financials, items, and timeline fields.
 */
export function parseDeepOrderData(node: DeepOrderGraphqlNode): ParsedOrderData {
  const rawLineItems = parseRawLineItems(node);
  const { physicalItems, feeItems } = splitLineItems(rawLineItems);
  const itemCount = physicalItemCount(rawLineItems);
  const events = timelineEvents(node);
  const eventMessages = timelineEventMessages(events);
  const financialStatus = node.displayFinancialStatus ?? "";
  const isRefunded = /refund/i.test(financialStatus) || Boolean(node.refunds?.length);
  const hasRefundTimeline = events.some((e) => /refund/i.test(e.message ?? ""));
  const timelineRefundReason = extractTimelineRefundReason(events);
  const refundReason =
    timelineRefundReason ??
    extractRefundReason(isRefunded, node.refunds, node.customAttributes, events);
  const cancelReason =
    humanizeShopifyCancelReason(node.cancelReason) ??
    (isRefunded || node.cancelledAt ? refundReason : undefined);
  const refundNotificationEmail =
    isRefunded || hasRefundTimeline
      ? extractRefundNotificationEmail(events, node.customAttributes)
      : undefined;
  const orderConfirmationEmail = extractOrderConfirmationEmail(events);
  const refundAmount = isRefunded ? extractRefundAmount(node.refunds) : undefined;
  const refundDate = isRefunded
    ? extractRefundNotificationDate(events, {
        processedAt: node.processedAt,
        updatedAt: node.updatedAt,
        isRefunded,
      })
    : undefined;
  const payment = extractPaymentMethod(
    transactionNodesFromConnection(node.transactions),
    node.paymentGatewayNames,
    node.refunds,
  );
  const orderPlacedAt = node.createdAt;
  const tags = normalizeOrderTags(node.tags);
  const channelName =
    node.channelInformation?.channelDefinition?.channelName?.trim() ||
    node.channelInformation?.channelDefinition?.handle?.trim() ||
    undefined;
  const publicationName = node.publication?.name?.trim() || undefined;
  const sourceName = node.sourceName?.trim() || undefined;
  const customAttributes = (node.customAttributes ?? [])
    .map((attr) => ({
      key: String(attr.key ?? "").trim(),
      value: String(attr.value ?? "").trim(),
    }))
    .filter((attr) => attr.key.length > 0);
  const transactions = transactionNodesFromConnection(node.transactions).map(
    summarizeTransactionForLlm,
  );

  return {
    orderNumber: node.name,
    customerName: customerDisplayName(node.customer),
    customerEmail: customerRegisteredEmail(node),
    orderPlacedAt,
    orderPlacedAtSpoken: orderPlacedAt ? formatOrderDateEnglish(orderPlacedAt) : undefined,
    subtotalAmount: subtotalFromNode(node),
    shippingFee: formatMoneyAmount(node.totalShippingPriceSet?.shopMoney),
    totalAmount: formatMoneyAmount(node.totalPriceSet?.shopMoney),
    totalTax: formatMoneyAmount(node.totalTaxSet?.shopMoney),
    totalDiscounts: formatMoneyAmount(node.totalDiscountsSet?.shopMoney),
    itemCount: itemCount || physicalItems.length,
    lineItems: physicalItems,
    feeLineItems: feeItems,
    isRefunded,
    refundReason,
    cancelReason,
    refundNotificationEmail,
    orderConfirmationEmail,
    events: eventMessages,
    orderNote: node.note?.trim() || undefined,
    tags: tags.length ? tags : undefined,
    sourceName,
    channelName,
    publicationName,
    isDraftOrderOrigin: detectDraftOrderOrigin(node),
    customAttributes: customAttributes.length ? customAttributes : undefined,
    transactions: transactions.length ? transactions : undefined,
    refundDate,
    refundAmount,
    fulfillmentStatus: node.displayFulfillmentStatus,
    cardLast4: payment.cardLast4,
    cardBrand: payment.cardBrand,
    paymentGateway: payment.paymentGateway,
    financialStatus,
    customerPhone: customerRegisteredPhone(node),
    shippingPhone: shippingAddressPhone(node),
    billingPhone: billingAddressPhone(node),
    customerId: node.customer?.id,
    shippingAddress: formatShippingAddress(node.shippingAddress),
    totalOrderCount: node.customer?.numberOfOrders,
  };
}

/** Build ParsedOrderData from an adapter OrderStatusResult. */
export function parsedDataFromOrderResult(result: OrderStatusResult): ParsedOrderData {
  const rawLineItems = result.lineItems ?? [];
  const { physicalItems, feeItems } = splitLineItems(rawLineItems);
  const itemCount = physicalItemCount(rawLineItems);

  return {
    orderNumber: result.orderNumber ?? "",
    customerName: result.customerName,
    customerEmail: result.customerEmail,
    orderPlacedAt: result.orderPlacedAt,
    orderPlacedAtSpoken: result.orderPlacedAt
      ? formatOrderDateEnglish(result.orderPlacedAt)
      : undefined,
    subtotalAmount: result.subtotalAmount,
    shippingFee: result.shippingFee,
    totalAmount: result.totalAmount,
    itemCount,
    lineItems: physicalItems,
    feeLineItems: feeItems,
    isRefunded: Boolean(result.refundStatus && /refund/i.test(result.refundStatus)),
    refundReason: result.refundReason,
    cancelReason: result.cancelReason ?? result.refundReason,
    refundNotificationEmail: result.refundNotificationEmail ?? result.refundEmail,
    orderConfirmationEmail: result.orderConfirmationEmail,
    events: result.events ?? [],
    refundDate: result.refundDate,
    refundAmount: result.refundAmount,
    fulfillmentStatus: result.fulfillmentStatus,
    trackingStatus: result.trackingStatus,
    estimatedDeliveryDays: result.estimatedDeliveryDays,
    cardLast4: result.cardLast4,
    cardBrand: result.cardBrand,
    paymentGateway: result.paymentGateway,
    financialStatus: result.financialStatus,
    trackingNumber: result.trackingNumber,
  };
}

/**
 * Proactive fluent-English order summary — delivered automatically once verified.
 *
 * Template:
 * "I found the order for [Customer Name], placed on [Order Date].
 *  The email associated with this account is [Customer Email].
 *  Your order contains [Total Items] items.
 *  The books cost [Subtotal Amount] and shipping was [Shipping Fee], making the total [Total Amount].
 *  [IF REFUNDED: This order was refunded because [Refund Reason].
 *   A refund confirmation email was sent to [Refund Email]]."
 */
export function buildProactiveOrderSummarySpeech(data: ParsedOrderData): string {
  const segments: string[] = [];

  let introduction = "I found the order";
  if (data.customerName?.trim()) {
    introduction += ` for ${data.customerName.trim()}`;
  }
  if (data.orderPlacedAtSpoken?.trim()) {
    introduction += `, placed on ${data.orderPlacedAtSpoken.trim()}`;
  }
  introduction += ".";
  segments.push(introduction);

  if (data.customerEmail?.trim()) {
    segments.push(
      `The email associated with this account is ${data.customerEmail.trim()}.`,
    );
  }

  if (data.itemCount > 0) {
    segments.push(
      data.itemCount === 1
        ? "Your order contains 1 item."
        : `Your order contains ${data.itemCount} items.`,
    );
  }

  const subtotal = data.subtotalAmount?.trim();
  const shipping = data.shippingFee?.trim();
  const total = data.totalAmount?.trim();

  if (subtotal && shipping && total) {
    segments.push(
      `The books cost ${speakMoney(subtotal)} and shipping was ${speakMoney(shipping)}, making the total ${speakMoney(total)}.`,
    );
  } else if (subtotal && total) {
    segments.push(
      `The books cost ${speakMoney(subtotal)}, making the total ${speakMoney(total)}.`,
    );
  } else if (total) {
    segments.push(`The total is ${speakMoney(total)}.`);
  }

  if (data.isRefunded) {
    const refundParts: string[] = [];
    if (data.refundReason?.trim()) {
      refundParts.push(`This order was refunded because ${data.refundReason.trim()}.`);
    } else {
      refundParts.push("This order was refunded.");
    }
    if (data.refundNotificationEmail?.trim()) {
      refundParts.push(
        `A refund confirmation email was sent to ${data.refundNotificationEmail.trim()}.`,
      );
    }
    segments.push(refundParts.join(" "));
  } else if (data.fulfillmentStatus?.trim()) {
    const statusParts: string[] = [
      `The order status is ${fulfillmentStatusPhrase(data.fulfillmentStatus)}.`,
    ];
    if (data.trackingStatus?.trim()) {
      statusParts.push(`Tracking shows ${data.trackingStatus.trim()}.`);
    }
    if (data.estimatedDeliveryDays !== undefined) {
      const days = data.estimatedDeliveryDays;
      const eta =
        days === 0
          ? "today or it may have already shipped"
          : days === 1
            ? "1 day"
            : `${days} days`;
      const inTransit = /transit|shipped|deliver/i.test(data.fulfillmentStatus);
      statusParts.push(
        inTransit ? `Expected delivery is in ${eta}.` : `Expected to ship in ${eta}.`,
      );
    }
    segments.push(statusParts.join(" "));
  }

  return segments.join(" ");
}

/**
 * Concise initial order response — delegates to verification-first protocol.
 */
export function buildProgressiveDisclosureOrderSpeech(
  data: ParsedOrderData,
  options?: { verified?: boolean; session?: import("../types/order.js").CallSession },
): string {
  void options?.verified;
  return buildVerificationFirstOrderSpeech(data, options?.session);
}
