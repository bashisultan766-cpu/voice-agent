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
