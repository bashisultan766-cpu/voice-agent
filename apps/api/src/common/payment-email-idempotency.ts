import { createHash } from 'crypto';

/** Idempotency key for duplicate product/email pairs before a checkout link exists. */
export function paymentRecipientPairIdempotencyKey(parts: {
  tenantId: string;
  agentId: string;
  productId: string;
  recipientEmail: string;
  callSid?: string | null;
}): string {
  const email = parts.recipientEmail.trim().toLowerCase();
  const base = [
    parts.tenantId,
    parts.agentId,
    parts.productId.trim().toLowerCase(),
    email,
    parts.callSid?.trim() ?? 'no_call',
    'payment_recipient_pair',
  ].join('|');
  return createHash('sha256').update(base, 'utf8').digest('hex');
}

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
