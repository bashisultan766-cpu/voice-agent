import {
  type AggregatedCheckoutLine,
  type EmailCheckoutBatch,
  linesFingerprint,
  mergeLinesByVariant,
  parseEmailCheckoutBatches,
} from '../../calls/runtime/order-aggregation-by-email.util';
import {
  normalizeRecipientEmail,
  parsePaymentRecipients,
  type PaymentRecipient,
} from '../../calls/runtime/payment-recipient.util';

export const CHECKOUT_STATE_LOOKBACK_MINUTES = 45;

export type CheckoutLinkHydrationRecord = {
  id: string;
  providerRef: string | null;
  checkoutUrl: string;
  customerEmail: string | null;
  itemsJson: unknown;
  metadata: unknown;
  status: string;
  sentAt: Date | null;
  createdAt: Date;
};

export function checkoutStateLookbackSince(now = new Date()): Date {
  return new Date(now.getTime() - CHECKOUT_STATE_LOOKBACK_MINUTES * 60 * 1000);
}

export function extractCallSidFromCheckoutMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const callSid = (metadata as Record<string, unknown>).callSid;
  return typeof callSid === 'string' && callSid.trim() ? callSid.trim() : null;
}

function parseCheckoutLinkLineItems(itemsJson: unknown): AggregatedCheckoutLine[] {
  if (!Array.isArray(itemsJson)) return [];
  const lines: AggregatedCheckoutLine[] = [];
  for (const row of itemsJson) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const variantId = typeof item.variantId === 'string' ? item.variantId.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const quantity =
      typeof item.quantity === 'number' && Number.isFinite(item.quantity)
        ? Math.max(1, Math.trunc(item.quantity))
        : 1;
    if (!variantId) continue;
    lines.push({
      productId: variantId,
      variantId,
      productTitle: title || 'Book',
      quantity,
    });
  }
  return lines;
}

function checkoutLinkInvoiceSent(record: CheckoutLinkHydrationRecord): boolean {
  if (record.status === 'SENT' || record.sentAt) return true;
  if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
    return false;
  }
  return (record.metadata as Record<string, unknown>).shopifyInvoiceSent === true;
}

export function hydrateCheckoutStateFromCheckoutLinks(
  records: CheckoutLinkHydrationRecord[],
  args: { callSid: string; email: string },
): { recipients: PaymentRecipient[]; batches: Record<string, EmailCheckoutBatch> } {
  const normalizedEmail = normalizeRecipientEmail(args.email);
  const relevant = records
    .filter((record) => {
      const recordEmail = record.customerEmail
        ? normalizeRecipientEmail(record.customerEmail)
        : '';
      if (recordEmail !== normalizedEmail) return false;
      const recordCallSid = extractCallSidFromCheckoutMetadata(record.metadata);
      return recordCallSid === args.callSid.trim();
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  if (!relevant.length) {
    return { recipients: [], batches: {} };
  }

  const canonicalDraftOrderId =
    relevant.find((record) => record.providerRef?.trim())?.providerRef?.trim() ?? null;
  const paymentLink =
    [...relevant].reverse().find((record) => record.checkoutUrl.trim())?.checkoutUrl.trim() ??
    null;

  const mergedLines = mergeLinesByVariant(
    relevant.flatMap((record) => parseCheckoutLinkLineItems(record.itemsJson)),
  );

  const shopifyInvoiceSent = relevant.some((record) => checkoutLinkInvoiceSent(record));
  const invoicedRecord = relevant.find((record) => checkoutLinkInvoiceSent(record));
  const invoicedLines = invoicedRecord
    ? mergeLinesByVariant(
        relevant
          .filter((record) => record.createdAt.getTime() <= invoicedRecord.createdAt.getTime())
          .flatMap((record) => parseCheckoutLinkLineItems(record.itemsJson)),
      )
    : [];

  const batch: EmailCheckoutBatch = {
    recipientEmail: normalizedEmail,
    draftOrderId: canonicalDraftOrderId,
    shopifyInvoiceSent,
    lines: mergedLines,
    status: shopifyInvoiceSent ? 'invoiced' : 'accumulating',
    invoicedLinesFingerprint:
      shopifyInvoiceSent && invoicedLines.length
        ? linesFingerprint(invoicedLines)
        : null,
  };

  const recipients: PaymentRecipient[] = mergedLines.map((line) => ({
    productId: line.productId,
    productTitle: line.productTitle,
    variantId: line.variantId,
    recipientEmail: normalizedEmail,
    paymentLink,
    paymentStatus: shopifyInvoiceSent ? 'link_sent' : 'email_confirmed',
    draftOrderId: canonicalDraftOrderId,
    checkoutLinkId: relevant[relevant.length - 1]?.id ?? null,
    quantity: line.quantity,
  }));

  return {
    recipients,
    batches: { [normalizedEmail]: batch },
  };
}

export function mergeCheckoutSessionState(args: {
  sessionRecipients: PaymentRecipient[];
  sessionBatches: ReturnType<typeof parseEmailCheckoutBatches>;
  hydratedRecipients: PaymentRecipient[];
  hydratedBatches: Record<string, EmailCheckoutBatch>;
}): {
  recipients: PaymentRecipient[];
  batches: ReturnType<typeof parseEmailCheckoutBatches>;
  hydrated: boolean;
} {
  const hasSessionState =
    args.sessionRecipients.length > 0 || Object.keys(args.sessionBatches).length > 0;
  if (hasSessionState) {
    return {
      recipients: args.sessionRecipients,
      batches: args.sessionBatches,
      hydrated: false,
    };
  }
  if (
    args.hydratedRecipients.length === 0 &&
    Object.keys(args.hydratedBatches).length === 0
  ) {
    return {
      recipients: [],
      batches: {},
      hydrated: false,
    };
  }
  return {
    recipients: args.hydratedRecipients,
    batches: parseEmailCheckoutBatches(args.hydratedBatches),
    hydrated: true,
  };
}
