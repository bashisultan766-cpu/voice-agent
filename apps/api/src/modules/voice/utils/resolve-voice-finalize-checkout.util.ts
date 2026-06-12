import { normalizeRecipientEmail } from '../../calls/runtime/payment-recipient.util';
import type { EmailCheckoutBatch } from '../../calls/runtime/order-aggregation-by-email.util';

/** Max books per aggregated invoice (protects VPS + Shopify from runaway tool loops). */
export const MAX_VOICE_CHECKOUT_LINES = 12;

/**
 * When ElevenLabs omits finalizeCheckout:
 * - First book on a call/email → finalize immediately (single-book fast path).
 * - Additional books already queued → keep queuing until explicit finalizeCheckout: true.
 */
export function resolveVoiceFinalizeCheckout(args: {
  explicit?: boolean;
  email: string;
  batches: Record<string, EmailCheckoutBatch>;
}): boolean {
  if (args.explicit === true) return true;
  if (args.explicit === false) return false;

  const batch = args.batches[normalizeRecipientEmail(args.email)];
  const queuedCount = batch?.lines?.length ?? 0;
  return queuedCount === 0;
}

export function isFinalizeOnlyRequest(args: {
  finalizeCheckout?: boolean;
  variantId?: string;
  productName?: string;
}): boolean {
  return (
    args.finalizeCheckout === true &&
    !args.variantId?.trim() &&
    !args.productName?.trim()
  );
}
