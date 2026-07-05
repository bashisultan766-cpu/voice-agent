/**
 * Pure extractors for Shopify order fields — timeline-first, zero-hallucination.
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

export interface OrderRefundNode {
  note?: string | null;
  totalRefundedSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  transactions?: Array<{
    gateway?: string;
    formattedGateway?: string;
    paymentDetails?: { company?: string; number?: string };
  }>;
}

export interface OrderTransactionNode {
  kind?: string;
  status?: string;
  gateway?: string;
  formattedGateway?: string;
  paymentDetails?: { company?: string; number?: string };
}

const EMAIL_RE = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/;

const REFUND_NOTIFICATION_SENT_RE =
  /refund\s+notification\s+(?:was\s+)?sent\s+to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;

/** Parenthetical email — e.g. "sent to Joel Moore (zzyxx2002@yahoo.com)". */
const SENT_TO_PAREN_EMAIL_RE = /sent\s+to\s+[^(]*\(([^)]+@[^)]+)\)/i;

/** Staff timeline — "sent a refund notification email to Blake Penfield (btazp@yahoo.com)". */
const REFUND_NOTIFICATION_EMAIL_PAREN_RE =
  /refund\s+notification\s+email\s+to\s+[^(]*\(([^)]+@[^)]+)\)/i;

/** Staff timeline — "Reason: OUT OF STOCK - ISSUE REFUND VIA PAYPAL". */
const TIMELINE_REASON_LINE_RE = /Reason:\s*(.+?)(?:\.|$)/i;

/** Spoken date tail — "on May 28" or "on May 28, 2025". */
const REFUND_ON_DATE_RE = /\bon\s+([A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)\b/i;

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

/**
 * Refund notification email — timeline/events first, then custom attributes.
 * NEVER falls back to the order's billing email (prevents Gmail hallucination).
 */
export function extractRefundNotificationEmail(
  events: OrderTimelineEvent[],
  customAttributes?: OrderCustomAttribute[],
): string | undefined {
  for (const event of [...events].reverse()) {
    const message = (event.message ?? "").trim();
    if (!message || !/refund/i.test(message)) continue;

    const notificationParen = message.match(REFUND_NOTIFICATION_EMAIL_PAREN_RE);
    if (notificationParen?.[1]) return notificationParen[1].trim();

    const explicit = message.match(REFUND_NOTIFICATION_SENT_RE);
    if (explicit?.[1]) return explicit[1].trim();

    const paren = message.match(SENT_TO_PAREN_EMAIL_RE);
    if (paren?.[1]) return paren[1].trim();

    if (/mail_sent|notification|sent to/i.test(message) || event.action === "mail_sent") {
      const found = message.match(EMAIL_RE);
      if (found?.[1]) return found[1].trim();
    }
  }

  for (const attr of customAttributes ?? []) {
    const key = (attr.key ?? "").toLowerCase();
    if ((key.includes("refund") && key.includes("email")) || key === "refund_email") {
      const value = (attr.value ?? "").trim();
      if (value && EMAIL_RE.test(value)) return value;
    }
  }

  return undefined;
}

/** Exact staff timeline reason — e.g. "OUT OF STOCK - ISSUE REFUND VIA PAYPAL". */
export function extractTimelineRefundReason(
  events: OrderTimelineEvent[],
): string | undefined {
  for (const event of events) {
    const message = (event.message ?? "").trim();
    if (!message) continue;
    const reasonLine = message.match(TIMELINE_REASON_LINE_RE);
    if (reasonLine?.[1]?.trim()) return reasonLine[1].trim();
  }
  return undefined;
}

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
    if (note && !/processing fee/i.test(note)) return note;
  }

  for (const event of events ?? []) {
    const message = (event.message ?? "").trim();
    if (!message || !/refund/i.test(message)) continue;
    const because = message.match(/(?:because|reason:?)\s+(.+?)(?:\.|$)/i);
    if (because?.[1]?.trim()) return because[1].trim();
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

export function extractPaymentMethod(
  transactions: OrderTransactionNode[] | undefined,
  paymentGatewayNames: string[] | undefined,
): { cardLast4?: string; cardBrand?: string; paymentGateway?: string } {
  const gateways = (paymentGatewayNames ?? []).map(formatGatewayLabel).filter(Boolean) as string[];
  const displayFromNames = gateways.length ? gateways.join(", ") : undefined;

  const saleTxn =
    transactions?.find(
      (t) =>
        t.status?.toUpperCase() === "SUCCESS" &&
        (t.kind?.toUpperCase() === "SALE" || t.kind?.toUpperCase() === "CAPTURE"),
    ) ?? transactions?.find((t) => t.status?.toUpperCase() === "SUCCESS") ?? transactions?.[0];

  const cardLast4 = extractCardLast4(saleTxn?.paymentDetails?.number);
  const cardBrand = saleTxn?.paymentDetails?.company;
  const txnGateway =
    formatGatewayLabel(saleTxn?.formattedGateway) ?? formatGatewayLabel(saleTxn?.gateway);

  return {
    cardLast4,
    cardBrand,
    paymentGateway: cardLast4 ? txnGateway ?? displayFromNames : txnGateway ?? displayFromNames,
  };
}
