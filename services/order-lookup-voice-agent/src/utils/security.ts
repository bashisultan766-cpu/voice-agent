import type { StructuredOrder } from "../types/order.js";

const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function isLikelyBookIsbn(digitRun: string): boolean {
  if (digitRun.length === 13 && /^97[89]/.test(digitRun)) return true;
  if (digitRun.length === 10 && /^\d{9}[\dX]$/i.test(digitRun)) return true;
  return false;
}

function redactCardNumbers(text: string): string {
  return text.replace(CARD_RE, (match) => {
    const digits = match.replace(/\D/g, "");
    return isLikelyBookIsbn(digits) ? match : "[card redacted]";
  });
}

export function sanitizeForSpeech(text: string): string {
  return redactCardNumbers(text)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn redacted]")
    .trim();
}

export function maskEmailForLogs(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "***";
  return `${user[0]}***@${domain}`;
}

export function isRefundEmailDisclosureAllowed(order: StructuredOrder): boolean {
  return Boolean(order.refund.refunded && order.refund.refundEmail);
}

export function redactShopifyPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  redactKeys(clone, [
    "email",
    "customer_email",
    "phone",
    "billing_address",
    "shipping_address",
    "payment_details",
    "credit_card",
    "client_details",
  ]);

  if (Array.isArray(clone.orders)) {
    clone.orders = clone.orders.map((o) => redactShopifyPayload(o));
  }
  if (clone.order && typeof clone.order === "object") {
    clone.order = redactShopifyPayload(clone.order);
  }

  return clone;
}

function redactKeys(obj: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (key in obj) obj[key] = "[redacted]";
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      redactKeys(value as Record<string, unknown>, keys);
    }
  }
}

export function extractLast4(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return undefined;
  return digits.slice(-4);
}

export function stripEmailsUnlessRefund(
  text: string,
  order: StructuredOrder,
): string {
  if (isRefundEmailDisclosureAllowed(order)) return text;
  return text.replace(EMAIL_RE, "[email withheld]");
}

export function safeCustomerFacingOrder(order: StructuredOrder): StructuredOrder {
  const safe = structuredClone(order);
  if (!isRefundEmailDisclosureAllowed(safe)) {
    safe.refund.refundEmail = undefined;
  }
  return safe;
}
