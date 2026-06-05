import type { PaymentRecipient } from './payment-recipient.types';
import {
  findPaymentRecipient,
  markRecipientEmailConfirmed,
  normalizeRecipientEmail,
  paymentRecipientPairKey,
} from './payment-recipient.util';

export type AggregatedCheckoutLine = {
  productId: string;
  variantId: string;
  productTitle: string;
  quantity: number;
};

export type EmailCheckoutPlan = {
  mode: 'create' | 'update';
  existingDraftOrderId: string | null;
  lines: AggregatedCheckoutLine[];
  /** True when a payment email was already delivered for this email on the call. */
  emailAlreadySentForEmail: boolean;
  /** Recipients after registering the current product as email_confirmed. */
  workingRecipients: PaymentRecipient[];
};

function recipientToLine(recipient: PaymentRecipient): AggregatedCheckoutLine | null {
  const variantId = recipient.variantId?.trim();
  if (!variantId) return null;
  return {
    productId: recipient.productId,
    variantId,
    productTitle: recipient.productTitle,
    quantity: Math.max(1, recipient.quantity ?? 1),
  };
}

function mergeLinesByVariant(lines: AggregatedCheckoutLine[]): AggregatedCheckoutLine[] {
  const map = new Map<string, AggregatedCheckoutLine>();
  for (const line of lines) {
    const key = line.variantId.trim().toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...line });
      continue;
    }
    existing.quantity += line.quantity;
  }
  return [...map.values()];
}

export function findDraftOrderIdForEmail(
  recipients: PaymentRecipient[],
  email: string,
): string | null {
  const normalized = normalizeRecipientEmail(email);
  for (const recipient of recipients) {
    if (normalizeRecipientEmail(recipient.recipientEmail) !== normalized) continue;
    if (recipient.draftOrderId?.trim()) return recipient.draftOrderId.trim();
  }
  return null;
}

export function emailPaymentLinkAlreadySent(
  recipients: PaymentRecipient[],
  email: string,
): boolean {
  const normalized = normalizeRecipientEmail(email);
  return recipients.some(
    (r) =>
      normalizeRecipientEmail(r.recipientEmail) === normalized &&
      r.paymentStatus === 'link_sent',
  );
}

/**
 * Build checkout lines for one recipient email: batch all confirmed-but-unsent
 * products, or append to an existing draft order when the email already has a sent link.
 */
export function buildEmailCheckoutPlan(
  recipients: PaymentRecipient[],
  email: string,
  current: AggregatedCheckoutLine,
): EmailCheckoutPlan {
  const normalized = normalizeRecipientEmail(email);
  let working = markRecipientEmailConfirmed(
    recipients,
    {
      title: current.productTitle,
      productId: current.productId,
      variantId: current.variantId,
    },
    normalized,
    current.quantity,
  );

  const existingDraftOrderId = findDraftOrderIdForEmail(working, normalized);
  const emailAlreadySentForEmail = emailPaymentLinkAlreadySent(working, normalized);

  const lines: AggregatedCheckoutLine[] = [];

  if (existingDraftOrderId && emailAlreadySentForEmail) {
    for (const recipient of working) {
      if (normalizeRecipientEmail(recipient.recipientEmail) !== normalized) continue;
      if (recipient.paymentStatus !== 'link_sent' && recipient.paymentStatus !== 'email_confirmed') {
        continue;
      }
      const line = recipientToLine(recipient);
      if (line) lines.push(line);
    }
    return {
      mode: 'update',
      existingDraftOrderId,
      lines: mergeLinesByVariant(lines),
      emailAlreadySentForEmail: true,
      workingRecipients: working,
    };
  }

  for (const recipient of working) {
    if (normalizeRecipientEmail(recipient.recipientEmail) !== normalized) continue;
    if (recipient.paymentStatus !== 'email_confirmed') continue;
    const line = recipientToLine(recipient);
    if (line) lines.push(line);
  }

  const merged = mergeLinesByVariant(lines);
  const hasCurrent = merged.some(
    (line) =>
      paymentRecipientPairKey(line.productId, normalized) ===
      paymentRecipientPairKey(current.productId, normalized),
  );
  if (!hasCurrent) {
    merged.push({ ...current });
  }

  return {
    mode: 'create',
    existingDraftOrderId: null,
    lines: mergeLinesByVariant(merged),
    emailAlreadySentForEmail: false,
    workingRecipients: working,
  };
}

export function recipientsAfterAggregatedSend(
  recipients: PaymentRecipient[],
  email: string,
  args: {
    draftOrderId: string;
    paymentLink: string;
    checkoutLinkId: string;
    productIds: string[];
  },
): PaymentRecipient[] {
  const normalized = normalizeRecipientEmail(email);
  const productIdSet = new Set(args.productIds.map((id) => id.trim().toLowerCase()));
  const updated = recipients.map((recipient) => {
    if (normalizeRecipientEmail(recipient.recipientEmail) !== normalized) return recipient;
    if (!productIdSet.has(recipient.productId.trim().toLowerCase())) return recipient;
    return {
      ...recipient,
      paymentStatus: 'link_sent' as const,
      paymentLink: args.paymentLink,
      draftOrderId: args.draftOrderId,
      checkoutLinkId: args.checkoutLinkId,
    };
  });
  const presentIds = new Set(
    updated
      .filter((r) => normalizeRecipientEmail(r.recipientEmail) === normalized)
      .map((r) => r.productId.trim().toLowerCase()),
  );
  for (const productId of args.productIds) {
    if (presentIds.has(productId.trim().toLowerCase())) continue;
    updated.push({
      productId,
      productTitle: productId,
      recipientEmail: normalized,
      paymentStatus: 'link_sent',
      paymentLink: args.paymentLink,
      draftOrderId: args.draftOrderId,
      checkoutLinkId: args.checkoutLinkId,
    });
  }
  return updated;
}

export function findPaymentRecipientByProductEmail(
  recipients: PaymentRecipient[],
  productId: string,
  email: string,
): PaymentRecipient | undefined {
  return findPaymentRecipient(recipients, productId, email);
}
