import { Logger } from '@nestjs/common';

/** Structured payment-link delivery logs (grep: delivery.) */
export function logDelivery(
  logger: Logger,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  logger.log(JSON.stringify({ event, ...payload }));
}

export function logDeliveryWarn(
  logger: Logger,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  logger.warn(JSON.stringify({ event, ...payload }));
}

export function logDeliveryError(
  logger: Logger,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  logger.error(JSON.stringify({ event, ...payload }));
}

/** Production failure envelope — Twilio/Resend/SendGrid (grep: delivery.failed). */
export function logPaymentDeliveryFailure(
  logger: Logger,
  event: string,
  input: {
    customerEmail: string;
    errorMessage: string;
    deliveryAttemptId: string | null;
    channel?: 'email' | 'sms' | 'whatsapp';
    provider?: string;
    [key: string]: unknown;
  },
): void {
  const { customerEmail, errorMessage, deliveryAttemptId, channel, provider, ...rest } = input;
  logger.error(
    JSON.stringify({
      event,
      customerEmail,
      errorMessage: errorMessage.slice(0, 500),
      deliveryAttemptId: deliveryAttemptId ?? null,
      timestamp: new Date().toISOString(),
      ...(channel ? { channel } : {}),
      ...(provider ? { provider } : {}),
      ...rest,
    }),
  );
}
