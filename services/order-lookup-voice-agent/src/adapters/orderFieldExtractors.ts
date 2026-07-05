/**
 * Pure extractors for Shopify order fields — timeline-first, zero-hallucination.
 * Omni-Extractor: aggressive timeline email + polymorphic payment card mapping.
 */

export interface OrderTimelineEvent {
  message?: string | null;
  action?: string | null;
  createdAt?: string | null;
}

export interface OrderCustomAttribute {
  key?: string;
  value?: string;
}

/** Polymorphic payment details — CardPaymentDetails, receipt aliases, REST shapes. */
export interface OrderPaymentDetails {
  company?: string;
  number?: string;
  /** CreditCardPaymentDetails / receipt alias for last four digits. */
  last4?: string;
  /** CreditCardPaymentDetails / receipt alias for card brand. */
  brand?: string;
  credit_card_number?: string;
  credit_card_company?: string;
}

export interface OrderRefundNode {
  note?: string | null;
  totalRefundedSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  /** Flat array (REST/minimal) or GraphQL connection (deep fetch). */
  transactions?:
    | OrderTransactionNode[]
    | {
        edges?: Array<{ node?: OrderTransactionNode }>;
      };
}

export interface OrderTransactionNode {
  kind?: string;
  status?: string;
  gateway?: string;
  formattedGateway?: string;
  paymentDetails?: OrderPaymentDetails;
  /** Shopify Admin GraphQL receipt blob (JSON string). */
  receiptJson?: string | null;
  /** REST-style receipt object or JSON string. */
  receipt?: string | Record<string, unknown> | null;
}

/** Standard email — intentionally loose; Shopify timeline copy changes often. */
const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;

/**
 * Staff timeline — "Reason: OUT OF STOCK - ISSUE REFUND VIA PAYPAL"
 * or smart-quoted "Reason: "Customer Cancel Order"".
 */
const TIMELINE_REASON_LINE_RE =
  /Reason:\s*[“"']?(.+?)[”"']?(?:\s*[.!]?\s*$|\s*\.(?:\s|$))/i;

/** Bare cancel phrases that appear as timeline/refund notes without a Reason: prefix. */
const CUSTOMER_CANCEL_ORDER_RE = /\bCustomer\s+Cancel(?:led)?\s+Order\b/i;

/** Spoken date tail — "on May 28" or "on May 28, 2025". */
const REFUND_ON_DATE_RE = /\bon\s+([A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)\b/i;

/** Strip wrapping straight/smart quotes from a captured reason. */
function stripReasonQuotes(raw: string): string {
  return raw
    .trim()
    .replace(/^[“"']+/, "")
    .replace(/[”"']+$/, "")
    .trim();
}

/** Flatten timeline nodes to non-empty message strings for LLM memory. */
export function timelineEventMessages(events: OrderTimelineEvent[]): string[] {
  return events
    .map((event) => (event.message ?? "").trim())
    .filter((message) => message.length > 0);
}

export function formatGatewayLabel(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase().replace(/_/g, " ");
  if (lower.includes("paypal")) return "PayPal Express Checkout";
  if (lower === "shopify payments" || lower === "shopify_payments") return "Shopify Payments";
  if (/^[a-z0-9_]+$/.test(trimmed)) {
    return trimmed.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return trimmed;
}

export function extractCardLast4(paymentNumber?: string): string | undefined {
  if (!paymentNumber) return undefined;
  const digits = paymentNumber.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

/** Timeline keyword gate — refund notification phrases (Shopify staff timeline copy). */
const REFUND_NOTIFICATION_PHRASE_RE =
  /refund(?:ed)?\s+notification|notification\s+(?:email\s+)?(?:was\s+)?sent|sent\s+a\s+refund\s+notification|refund\s+notification\s+email/i;

function emailFromTimelineMessage(message: string): string | undefined {
  const found = message.match(EMAIL_RE);
  return found?.[1]?.trim();
}

/**
 * Omni-Extractor: refund notification email.
 * Scans timeline newest-first — Shopify logs refund notification on staff timeline events.
 * Requires "refund" in the message OR an explicit refund-notification phrase plus email.
 * NEVER falls back to the order billing email (prevents Gmail hallucination).
 */
export function extractRefundNotificationEmail(
  events: OrderTimelineEvent[],
  customAttributes?: OrderCustomAttribute[],
): string | undefined {
  for (const event of [...events].reverse()) {
    const message = (event.message ?? "").trim();
    if (!message) continue;
    if (!/refund/i.test(message) && !REFUND_NOTIFICATION_PHRASE_RE.test(message)) continue;
    const email = emailFromTimelineMessage(message);
    if (email) return email;
  }

  for (const event of [...events].reverse()) {
    const message = (event.message ?? "").trim();
    if (!message || !/notification/i.test(message) || /confirm/i.test(message)) continue;
    if (!/refund|refunded|mail_sent/i.test(`${message} ${event.action ?? ""}`)) continue;
    const email = emailFromTimelineMessage(message);
    if (email) return email;
  }

  for (const attr of customAttributes ?? []) {
    const key = (attr.key ?? "").toLowerCase();
    if ((key.includes("refund") && key.includes("email")) || key === "refund_email") {
      const value = (attr.value ?? "").trim();
      if (value && EMAIL_RE.test(value)) return value.match(EMAIL_RE)?.[1]?.trim() ?? value;
    }
  }

  return undefined;
}

/** @deprecated Alias — prefer extractRefundNotificationEmail. */
export const extractRefundEmail = extractRefundNotificationEmail;

/** Re-parse refund notification email from flat timeline message strings (session follow-up). */
export function extractRefundNotificationEmailFromMessages(
  messages: string[],
): string | undefined {
  const events = messages.map((message) => ({ message }));
  return extractRefundNotificationEmail(events, []);
}

/** Exact staff timeline reason — e.g. "OUT OF STOCK - ISSUE REFUND VIA PAYPAL". */
export function extractTimelineRefundReason(
  events: OrderTimelineEvent[],
): string | undefined {
  for (const event of events) {
    const message = (event.message ?? "").trim();
    if (!message) continue;
    const reasonLine = message.match(TIMELINE_REASON_LINE_RE);
    if (reasonLine?.[1]) {
      const cleaned = stripReasonQuotes(reasonLine[1]);
      if (cleaned) return cleaned;
    }
    const cancelMatch = message.match(CUSTOMER_CANCEL_ORDER_RE);
    if (cancelMatch?.[0]) return cancelMatch[0].trim();
  }
  return undefined;
}

/**
 * Omni-Extractor: order confirmation email.
 * Any timeline event containing "confirm" or "placed" (case-insensitive) plus a
 * standard email address is accepted — do not rely on exact Shopify sentence structures.
 * NEVER falls back to the order's billing email.
 */
export function extractOrderConfirmationEmail(
  events: OrderTimelineEvent[],
): string | undefined {
  for (const event of [...events].reverse()) {
    const message = (event.message ?? "").trim();
    if (!message) continue;
    if (!/confirm|placed/i.test(message)) continue;
    if (/refund/i.test(message)) continue;
    const found = message.match(EMAIL_RE);
    if (found?.[1]) return found[1].trim();
  }
  return undefined;
}

/** @deprecated Alias — prefer extractOrderConfirmationEmail. */
export const extractConfirmationEmail = extractOrderConfirmationEmail;

/**
 * Refund / notification date from timeline text ("on May 28") or event timestamp.
 * Falls back to processedAt / updatedAt when refunded.
 */
export function extractRefundNotificationDate(
  events: OrderTimelineEvent[],
  options?: { processedAt?: string | null; updatedAt?: string | null; isRefunded?: boolean },
): string | undefined {
  for (const event of events) {
    const message = (event.message ?? "").trim();
    if (!message || !/refund/i.test(message)) continue;

    const spokenDate = message.match(REFUND_ON_DATE_RE);
    if (spokenDate?.[1]?.trim()) return spokenDate[1].trim();
  }

  for (const event of [...events].reverse()) {
    const message = (event.message ?? "").trim();
    if (
      event.createdAt &&
      (/refund|mail_sent|notification/i.test(message) ||
        /refund|mail_sent/i.test(event.action ?? ""))
    ) {
      return event.createdAt;
    }
  }

  if (options?.isRefunded) {
    if (options.processedAt) return options.processedAt;
    if (options.updatedAt) return options.updatedAt;
  }

  return undefined;
}

export function extractRefundReason(
  isRefunded: boolean,
  refunds?: OrderRefundNode[],
  customAttributes?: OrderCustomAttribute[],
  events?: OrderTimelineEvent[],
): string | undefined {
  if (!isRefunded) return undefined;

  const timelineReason = extractTimelineRefundReason(events ?? []);
  if (timelineReason) return timelineReason;

  for (const attr of customAttributes ?? []) {
    const key = (attr.key ?? "").toLowerCase();
    if (key.includes("refund") && key.includes("reason") && attr.value?.trim()) {
      return attr.value.trim();
    }
  }

  for (const refund of refunds ?? []) {
    const note = (refund.note ?? "").trim();
    if (!note || /processing fee/i.test(note)) continue;
    const cancelMatch = note.match(CUSTOMER_CANCEL_ORDER_RE);
    if (cancelMatch?.[0]) return cancelMatch[0].trim();
    return stripReasonQuotes(note);
  }

  for (const event of events ?? []) {
    const message = (event.message ?? "").trim();
    if (!message || !/refund/i.test(message)) continue;
    const because = message.match(/(?:because|reason:?)\s*[“"']?(.+?)[”"']?(?:\.|$)/i);
    if (because?.[1]?.trim()) return stripReasonQuotes(because[1]);
  }

  return undefined;
}

export function extractRefundAmount(refunds?: OrderRefundNode[]): string | undefined {
  for (const refund of refunds ?? []) {
    const money = refund.totalRefundedSet?.shopMoney;
    if (money?.amount) {
      const code = money.currencyCode ?? "USD";
      return `${money.amount} ${code}`;
    }
  }
  return undefined;
}

export interface FulfillmentTrackingInfo {
  company?: string;
  number?: string;
  url?: string;
}

export interface FulfillmentNode {
  trackingInfo?: FulfillmentTrackingInfo[];
}

/** Primary tracking number and carrier from Shopify fulfillments. */
export function extractTrackingInfo(
  fulfillments?: FulfillmentNode[],
): { trackingNumber?: string; trackingCompany?: string; trackingUrl?: string } {
  if (!fulfillments?.length) return {};

  const withTracking = fulfillments.find((f) =>
    f.trackingInfo?.some((t) => t.number?.trim() || t.url?.trim()),
  );
  const fulfillment = withTracking ?? fulfillments[0];
  const tracking = fulfillment?.trackingInfo?.find((t) => t.number?.trim() || t.url?.trim());

  return {
    trackingNumber: tracking?.number?.trim() || undefined,
    trackingCompany: tracking?.company?.trim() || undefined,
    trackingUrl: tracking?.url?.trim() || undefined,
  };
}

/** Parse receiptJson / receipt for payment_method_details.card.{last4,brand}. */
export function extractCardFromReceipt(
  receipt: string | Record<string, unknown> | null | undefined,
): { cardLast4?: string; cardBrand?: string } {
  if (receipt == null) return {};

  let obj: Record<string, unknown>;
  if (typeof receipt === "string") {
    const trimmed = receipt.trim();
    if (!trimmed) return {};
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {};
    }
  } else {
    obj = receipt;
  }

  const paymentMethodDetails = obj.payment_method_details as
    | Record<string, unknown>
    | undefined;
  const card = (paymentMethodDetails?.card ?? obj.card) as
    | Record<string, unknown>
    | undefined;

  const cardLast4 =
    extractCardLast4(typeof card?.last4 === "string" ? card.last4 : undefined) ??
    extractCardLast4(
      typeof obj.credit_card_number === "string" ? obj.credit_card_number : undefined,
    );
  const cardBrand =
    (typeof card?.brand === "string" ? card.brand : undefined) ??
    (typeof card?.company === "string" ? card.company : undefined) ??
    (typeof obj.credit_card_company === "string" ? obj.credit_card_company : undefined);

  return { cardLast4, cardBrand };
}

/** Map polymorphic paymentDetails (number/last4, company/brand) to voice fields. */
export function extractCardFromPaymentDetails(
  paymentDetails?: OrderPaymentDetails | null,
): { cardLast4?: string; cardBrand?: string } {
  if (!paymentDetails) return {};
  const cardLast4 =
    extractCardLast4(paymentDetails.last4) ??
    extractCardLast4(paymentDetails.number) ??
    extractCardLast4(paymentDetails.credit_card_number);
  const cardBrand =
    paymentDetails.brand ??
    paymentDetails.company ??
    paymentDetails.credit_card_company;
  return {
    cardLast4,
    cardBrand: cardBrand?.trim() || undefined,
  };
}

function cardFromTransaction(txn: OrderTransactionNode): {
  cardLast4?: string;
  cardBrand?: string;
} {
  const fromDetails = extractCardFromPaymentDetails(txn.paymentDetails);
  const fromReceipt = extractCardFromReceipt(txn.receiptJson ?? txn.receipt);
  return {
    cardLast4: fromDetails.cardLast4 ?? fromReceipt.cardLast4,
    cardBrand: fromDetails.cardBrand ?? fromReceipt.cardBrand,
  };
}

function refundTransactionNodes(refund: OrderRefundNode): OrderTransactionNode[] {
  const raw = refund.transactions;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return (raw.edges ?? [])
    .map((edge) => edge.node)
    .filter((node): node is OrderTransactionNode => node != null);
}

/**
 * Omni-Extractor: payment_method_last4 + card_brand.
 * Scans sale/capture transactions, then any success txn, then refund transactions.
 * Reads paymentDetails (number/last4, company/brand) and receipt / receiptJson.
 */
export function extractPaymentMethod(
  transactions: OrderTransactionNode[] | undefined,
  paymentGatewayNames: string[] | undefined,
  refunds?: OrderRefundNode[],
): { cardLast4?: string; cardBrand?: string; paymentGateway?: string } {
  const gateways = (paymentGatewayNames ?? []).map(formatGatewayLabel).filter(Boolean) as string[];
  const displayFromNames = gateways.length ? gateways.join(", ") : undefined;

  const refundTxns = (refunds ?? []).flatMap((refund) => refundTransactionNodes(refund));
  const allTxns: OrderTransactionNode[] = [...(transactions ?? []), ...refundTxns];

  const preferred =
    allTxns.find(
      (t) =>
        t.status?.toUpperCase() === "SUCCESS" &&
        (t.kind?.toUpperCase() === "SALE" || t.kind?.toUpperCase() === "CAPTURE"),
    ) ??
    allTxns.find((t) => t.status?.toUpperCase() === "SUCCESS") ??
    allTxns[0];

  let cardLast4: string | undefined;
  let cardBrand: string | undefined;

  const scanOrder = preferred
    ? [preferred, ...allTxns.filter((t) => t !== preferred)]
    : allTxns;

  for (const txn of scanOrder) {
    const card = cardFromTransaction(txn);
    if (card.cardLast4) {
      cardLast4 = card.cardLast4;
      cardBrand = card.cardBrand ?? cardBrand;
      break;
    }
    if (!cardBrand && card.cardBrand) cardBrand = card.cardBrand;
  }

  const txnGateway =
    formatGatewayLabel(preferred?.formattedGateway) ??
    formatGatewayLabel(preferred?.gateway);

  return {
    cardLast4,
    cardBrand,
    paymentGateway: txnGateway ?? displayFromNames,
  };
}
