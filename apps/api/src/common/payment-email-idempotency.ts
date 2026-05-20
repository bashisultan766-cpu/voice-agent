import { createHash } from 'crypto';

/** Deterministic idempotency key for payment-link emails (per tenant, link, and recipient). */
export function paymentEmailIdempotencyKey(parts: {
  tenantId: string;
  agentId: string;
  checkoutLinkId: string;
  recipientEmail: string;
  /** Namespace retries (e.g. dev test vs voice tool). */
  purpose?: string;
}): string {
  const email = parts.recipientEmail.trim().toLowerCase();
  const base = [
    parts.tenantId,
    parts.agentId,
    parts.checkoutLinkId,
    email,
    parts.purpose ?? 'payment_link',
  ].join('|');
  return createHash('sha256').update(base, 'utf8').digest('hex');
}
