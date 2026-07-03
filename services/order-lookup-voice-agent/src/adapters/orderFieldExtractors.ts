/**
 * Pure extractors for Shopify order fields — timeline-first, zero-hallucination.
 */

export interface OrderTimelineEvent {
  message?: string | null;
  action?: string | null;
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

export function extractRefundReason(
  isRefunded: boolean,
  refunds?: OrderRefundNode[],
  customAttributes?: OrderCustomAttribute[],
  events?: OrderTimelineEvent[],
): string | undefined {
  if (!isRefunded) return undefined;

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
