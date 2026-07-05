/**
 * Deterministic follow-up speech for order fields — bypasses LLM when Shopify data is present.
 */
import {
  extractRefundNotificationEmailFromMessages,
} from "../adapters/orderFieldExtractors.js";
import type { ActiveOrderContextData } from "./sessionManager.js";
import { formatEmailForTTS } from "../utils/ttsFormatter.js";

const REFUND_EMAIL_QUESTION_RE =
  /\b(refund(?:ed)?\s+(?:notification\s+)?email|email.*refund|refund.*email|refund.*notification|notification.*refund|where.*refund.*sent|which email.*refund|email on which)\b/i;

const ARCHIVED_TIMELINE_MS = 365 * 24 * 60 * 60 * 1000;

function timelineMessagesFromContext(context: ActiveOrderContextData): string[] {
  const events = context.events;
  if (!Array.isArray(events)) return [];
  return events.map((entry) => String(entry).trim()).filter(Boolean);
}

function orderPlacedAtFromContext(context: ActiveOrderContextData): string | undefined {
  const raw =
    (context.order_placed_at as string | null | undefined) ??
    (context.orderPlacedAt as string | null | undefined);
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function customerEmailFromContext(context: ActiveOrderContextData): string | undefined {
  const raw =
    (context.customer_email as string | null | undefined) ??
    (context.customerEmail as string | null | undefined);
  return typeof raw === "string" && raw.includes("@") ? raw.trim() : undefined;
}

/** True when Shopify timeline events are archived (order placed more than 1 year ago). */
export function isArchivedShopifyTimelineOrder(
  orderPlacedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!orderPlacedAt?.trim()) return false;
  const placed = new Date(orderPlacedAt);
  if (Number.isNaN(placed.getTime())) return false;
  return now.getTime() - placed.getTime() > ARCHIVED_TIMELINE_MS;
}

function yearFromOrderPlacedAt(orderPlacedAt: string): string {
  const placed = new Date(orderPlacedAt);
  if (!Number.isNaN(placed.getTime())) {
    return String(placed.getUTCFullYear());
  }
  const match = orderPlacedAt.match(/\b(20\d{2})\b/);
  return match?.[1] ?? "an earlier year";
}

/**
 * Legacy Order Fallback — archived Shopify timelines (orders > 1 year old).
 * Uses master customer_email only when refund_notification_email is unavailable.
 */
export function buildLegacyOrderRefundEmailSpeech(
  context: ActiveOrderContextData,
): string | undefined {
  const orderPlacedAt = orderPlacedAtFromContext(context);
  if (!isArchivedShopifyTimelineOrder(orderPlacedAt)) return undefined;

  const customerEmail = customerEmailFromContext(context);
  const spoken =
    (context.customer_email_for_tts as string | null | undefined)?.trim() ||
    formatEmailForTTS(customerEmail);
  if (!customerEmail || !spoken) return undefined;

  const year = yearFromOrderPlacedAt(orderPlacedAt!);
  return (
    `Because this order is from ${year}, the specific email notification logs have been securely archived by Shopify. ` +
    `However, the master contact email on file for this account is ${spoken}. ` +
    "It is highly likely the refund notification was routed there."
  );
}

/**
 * Resolve refund notification email from context fields or re-parse Shopify timeline events.
 */
export function resolveRefundNotificationEmail(
  context: ActiveOrderContextData,
): string | undefined {
  const direct =
    (context.refund_notification_email as string | null | undefined) ??
    (context.refund_email as string | null | undefined);
  if (typeof direct === "string" && direct.includes("@")) {
    return direct.trim();
  }

  return extractRefundNotificationEmailFromMessages(timelineMessagesFromContext(context));
}

/** True when the caller is asking which email received the refund notification. */
export function isRefundNotificationEmailQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (REFUND_EMAIL_QUESTION_RE.test(trimmed)) return true;

  const lower = trimmed.toLowerCase();
  const mentionsEmail = /\b(email|inbox|e-mail)\b/i.test(trimmed);
  const mentionsRefundNotice =
    /\brefund/i.test(lower) && /\b(notification|notified|notice)\b/i.test(lower);
  const mentionsWhichEmail =
    /\b(which|what)\s+email\b/i.test(lower) &&
    /\b(refund|notification|sent)\b/i.test(lower);
  const mentionsNotReceived =
    /\b(didn't|did not|never|not|haven't|have not)\s+(get|receive|got|see|find)\b/i.test(
      lower,
    ) && /\b(refund|notification)\b/i.test(lower);

  return (
    (mentionsEmail && mentionsRefundNotice) ||
    mentionsWhichEmail ||
    mentionsNotReceived
  );
}

export function isRefundNotificationDeliveryComplaint(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    /\b(didn't|did not|never|not|haven't|have not)\s+(get|receive|got|see|find)\b/i.test(
      lower,
    ) &&
    /\b(refund|notification)\b/i.test(lower)
  );
}

/**
 * Grounded refund-notification email answer from ACTIVE ORDER CONTEXT.
 * Uses Shopify timeline-extracted refund_notification_email when present.
 * For archived orders (> 1 year), applies LEGACY ORDER FALLBACK with customer_email.
 */
export function buildRefundNotificationEmailSpeech(
  context: ActiveOrderContextData,
): string {
  const raw = resolveRefundNotificationEmail(context);
  const spoken = formatEmailForTTS(raw);

  if (raw && spoken) {
    return (
      `I can confirm the refund notification email was sent to ${spoken}. ` +
      "Please check your inbox and spam folder."
    );
  }

  const legacySpeech = buildLegacyOrderRefundEmailSpeech(context);
  if (legacySpeech) {
    return legacySpeech;
  }

  return (
    "I checked the official system logs for this order, but that specific detail is not on file."
  );
}

/** Same as buildRefundNotificationEmailSpeech but for callers who say they did not receive it. */
export function buildRefundNotificationComplaintSpeech(
  context: ActiveOrderContextData,
  callerText: string,
): string {
  const raw = resolveRefundNotificationEmail(context);
  const spoken = formatEmailForTTS(raw);

  if (raw && spoken) {
    return (
      `I understand you did not receive it. Our Shopify timeline shows the refund notification was sent to ${spoken}. ` +
      "Please check your inbox and spam folder at that address."
    );
  }

  const legacySpeech = buildLegacyOrderRefundEmailSpeech(context);
  if (legacySpeech) {
    return (
      `I understand you did not receive it. ${legacySpeech} ` +
      "Please check your inbox and spam folder at that address."
    );
  }

  if (isRefundNotificationDeliveryComplaint(callerText)) {
    return (
      "I checked the official system logs for this order, but the refund notification email address is not on file."
    );
  }

  return buildRefundNotificationEmailSpeech(context);
}

export function buildRefundEmailFollowUpSpeech(
  context: ActiveOrderContextData,
  callerText: string,
): string {
  if (isRefundNotificationDeliveryComplaint(callerText)) {
    return buildRefundNotificationComplaintSpeech(context, callerText);
  }
  return buildRefundNotificationEmailSpeech(context);
}
