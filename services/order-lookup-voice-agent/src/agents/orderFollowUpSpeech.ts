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

function timelineMessagesFromContext(context: ActiveOrderContextData): string[] {
  const events = context.events;
  if (!Array.isArray(events)) return [];
  return events.map((entry) => String(entry).trim()).filter(Boolean);
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
 * Uses Shopify timeline-extracted refund_notification_email only — never billing email.
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
