/**
 * Deterministic follow-up speech for order fields — bypasses LLM when Shopify data is present.
 */
import type { ActiveOrderContextData } from "./sessionManager.js";
import { formatEmailForTTS } from "../utils/ttsFormatter.js";

const REFUND_EMAIL_QUESTION_RE =
  /\b(refund(?:ed)?\s+(?:notification\s+)?email|email.*refund|refund.*email|refund.*notification|notification.*refund|where.*refund.*sent|which email.*refund)\b/i;

/** True when the caller is asking which email received the refund notification. */
export function isRefundNotificationEmailQuestion(text: string): boolean {
  return REFUND_EMAIL_QUESTION_RE.test(text.trim());
}

/**
 * Grounded refund-notification email answer from ACTIVE ORDER CONTEXT.
 * Uses Shopify timeline-extracted refund_notification_email only — never billing email.
 */
export function buildRefundNotificationEmailSpeech(
  context: ActiveOrderContextData,
): string {
  const raw =
    (context.refund_notification_email as string | null | undefined) ??
    (context.refund_email as string | null | undefined);
  const spoken =
    (context.refund_notification_email_for_tts as string | null | undefined) ??
    formatEmailForTTS(raw);

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
