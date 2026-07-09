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
  type OrderCustomAttribute,
  type OrderRefundNode,
  type OrderTimelineEvent,
  type OrderTransactionNode,
} from "../adapters/orderFieldExtractors.js";
import { physicalItemCount, splitLineItems } from "./productLineItems.js";
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
  customAttributes?: OrderCustomAttribute[];
  paymentGatewayNames?: string[];
  events?: {
    edges?: Array<{
      node?: OrderTimelineEvent;
    }>;
  };
  lineItems?: {
    edges?: Array<{
      node?: {
        title?: string;
        quantity?: number;
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
  itemCount: number;
  lineItems: Array<{ title: string; quantity: number; price?: string }>;
  feeLineItems: Array<{ title: string; quantity: number; price?: string }>;
  isRefunded: boolean;
  refundReason?: string;
  /** Shopify cancelReason enum or timeline-derived cancellation cause. */
  cancelReason?: string;
  refundNotificationEmail?: string;
  orderConfirmationEmail?: string;
  /** Raw timeline messages — injected into LLM session memory for follow-ups. */
  events: string[];
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

function timelineEvents(node: DeepOrderGraphqlNode): OrderTimelineEvent[] {
  return (node.events?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is OrderTimelineEvent => Boolean(n));
}

function parseRawLineItems(
  node: DeepOrderGraphqlNode,
): Array<{ title: string; quantity: number; price?: string }> {
  return (
    node.lineItems?.edges
      ?.map((e) => {
        const title = e.node?.title?.trim();
        if (!title) return null;
        const price = formatMoneyAmount(e.node?.originalUnitPriceSet?.shopMoney);
        return {
          title,
          quantity: e.node?.quantity ?? 1,
          ...(price ? { price } : {}),
        };
      })
      .filter(
        (li): li is { title: string; quantity: number; price?: string } => li !== null,
      ) ?? []
  );
}

function parseLineItems(
  node: DeepOrderGraphqlNode,
): Array<{ title: string; quantity: number; price?: string }> {
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

  return {
    orderNumber: node.name,
    customerName: customerDisplayName(node.customer),
    customerEmail: customerRegisteredEmail(node),
    orderPlacedAt,
    orderPlacedAtSpoken: orderPlacedAt ? formatOrderDateEnglish(orderPlacedAt) : undefined,
    subtotalAmount: subtotalFromNode(node),
    shippingFee: formatMoneyAmount(node.totalShippingPriceSet?.shopMoney),
    totalAmount: formatMoneyAmount(node.totalPriceSet?.shopMoney),
    itemCount: itemCount || physicalItems.length,
    lineItems: physicalItems,
    feeLineItems: feeItems,
    isRefunded,
    refundReason,
    cancelReason,
    refundNotificationEmail,
    orderConfirmationEmail,
    events: eventMessages,
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
 * Concise initial order response — progressive disclosure (status + date only).
 * Template: "Your order [ID] is [Status] as of [Date]."
 */
export function buildProgressiveDisclosureOrderSpeech(
  data: ParsedOrderData,
  options?: { verified?: boolean },
): string {
  const verified = options?.verified !== false;
  const orderId = data.orderNumber?.replace(/^#/, "") ?? "unknown";

  let statusPhrase: string;
  if (data.isRefunded) {
    statusPhrase = "Refunded";
  } else if (data.fulfillmentStatus?.trim()) {
    statusPhrase = fulfillmentStatusPhrase(data.fulfillmentStatus);
  } else {
    statusPhrase = "being processed";
  }

  const asOfDate =
    data.refundDate?.trim() ||
    data.orderPlacedAtSpoken?.trim() ||
    data.orderPlacedAt?.trim() ||
    "today";

  if (!verified) {
    return `Your order ${orderId} is ${statusPhrase} as of ${asOfDate}.`;
  }

  return `Your order ${orderId} is ${statusPhrase} as of ${asOfDate}.`;
}
