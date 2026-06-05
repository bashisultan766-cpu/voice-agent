import { createHash } from 'crypto';
import type { PaymentRecipient } from './payment-recipient.types';
import {
  findPaymentRecipient,
  markRecipientEmailConfirmed,
  normalizeRecipientEmail,
  paymentRecipientPairKey,
} from './payment-recipient.util';

export const EMAIL_CHECKOUT_BATCHES_KEY = 'emailCheckoutBatches';

export type AggregatedCheckoutLine = {
  productId: string;
  variantId: string;
  productTitle: string;
  quantity: number;
};

export type EmailCheckoutBatch = {
  recipientEmail: string;
  draftOrderId: string | null;
  shopifyInvoiceSent: boolean;
  lines: AggregatedCheckoutLine[];
  status: 'accumulating' | 'invoiced';
  /** Line-item fingerprint when the Shopify invoice was last sent. */
  invoicedLinesFingerprint?: string | null;
};

export type CheckoutExecutionPlan = {
  aggregationMode: 'queue' | 'create' | 'update' | 'duplicate_prevented';
  finalizeCheckout: boolean;
  lines: AggregatedCheckoutLine[];
  existingDraftOrderId: string | null;
  shopifyInvoiceAlreadySent: boolean;
  duplicateInvoicePrevented: boolean;
  resendEmailSkippedBecauseShopifySent: boolean;
  sendShopifyInvoice: boolean;
  skipResendEmail: boolean;
  workingRecipients: PaymentRecipient[];
  batch: EmailCheckoutBatch;
  idempotencyKey: string;
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

export function variantIdSetFingerprint(lines: AggregatedCheckoutLine[]): string {
  return [...new Set(lines.map((line) => line.variantId.trim().toLowerCase()))].sort().join('|');
}

export function mergeLinesByVariant(lines: AggregatedCheckoutLine[]): AggregatedCheckoutLine[] {
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

export function linesFingerprint(lines: AggregatedCheckoutLine[]): string {
  return mergeLinesByVariant(lines)
    .map((line) => `${line.variantId}:${line.quantity}`)
    .sort()
    .join('|');
}

export function parseEmailCheckoutBatches(raw: unknown): Record<string, EmailCheckoutBatch> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, EmailCheckoutBatch> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const recipientEmail =
      typeof row.recipientEmail === 'string' ? normalizeRecipientEmail(row.recipientEmail) : key;
    const lines = Array.isArray(row.lines)
      ? (row.lines as AggregatedCheckoutLine[]).filter(
          (line) =>
            line &&
            typeof line.productId === 'string' &&
            typeof line.variantId === 'string' &&
            typeof line.productTitle === 'string',
        )
      : [];
    out[normalizeRecipientEmail(key)] = {
      recipientEmail,
      draftOrderId: typeof row.draftOrderId === 'string' ? row.draftOrderId : null,
      shopifyInvoiceSent: row.shopifyInvoiceSent === true,
      lines: mergeLinesByVariant(lines),
      status: row.status === 'invoiced' ? 'invoiced' : 'accumulating',
      invoicedLinesFingerprint:
        typeof row.invoicedLinesFingerprint === 'string' ? row.invoicedLinesFingerprint : null,
    };
  }
  return out;
}

export function checkoutSessionIdempotencyKey(
  callSid: string | null | undefined,
  email: string,
  draftOrderId?: string | null,
): string {
  return createHash('sha256')
    .update(
      [
        callSid?.trim() ?? 'no_call',
        normalizeRecipientEmail(email),
        draftOrderId?.trim() ?? 'no_draft',
        'voice_checkout_session',
      ].join('|'),
      'utf8',
    )
    .digest('hex');
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

export function registerLineToEmailBatch(
  batch: EmailCheckoutBatch,
  line: AggregatedCheckoutLine,
): EmailCheckoutBatch {
  const existing = batch.lines.find(
    (row) =>
      row.variantId.trim().toLowerCase() === line.variantId.trim().toLowerCase() &&
      row.productId.trim().toLowerCase() === line.productId.trim().toLowerCase() &&
      row.quantity === line.quantity,
  );
  if (existing) {
    return batch;
  }
  const merged = mergeLinesByVariant([...batch.lines, line]);
  return {
    ...batch,
    recipientEmail: batch.recipientEmail || normalizeRecipientEmail(line.productId),
    lines: merged,
    status: batch.status === 'invoiced' ? 'invoiced' : 'accumulating',
  };
}

export function buildCheckoutExecutionPlan(args: {
  recipients: PaymentRecipient[];
  batches: Record<string, EmailCheckoutBatch>;
  email: string;
  callSid?: string | null;
  current: AggregatedCheckoutLine;
  finalizeCheckout: boolean;
}): CheckoutExecutionPlan {
  const normalized = normalizeRecipientEmail(args.email);
  const workingRecipients = markRecipientEmailConfirmed(
    args.recipients,
    {
      title: args.current.productTitle,
      productId: args.current.productId,
      variantId: args.current.variantId,
    },
    normalized,
    args.current.quantity,
  );

  const existingBatch = args.batches[normalized];
  const shopifyInvoiceAlreadySentBeforeRegister =
    (existingBatch?.shopifyInvoiceSent ?? false) ||
    emailPaymentLinkAlreadySent(args.recipients, normalized);

  if (
    args.finalizeCheckout &&
    existingBatch?.status === 'invoiced' &&
    existingBatch.invoicedLinesFingerprint &&
    shopifyInvoiceAlreadySentBeforeRegister
  ) {
    const projected = registerLineToEmailBatch(existingBatch, args.current);
    if (existingBatch.invoicedLinesFingerprint === linesFingerprint(projected.lines)) {
      return {
        aggregationMode: 'duplicate_prevented',
        finalizeCheckout: true,
        lines: projected.lines,
        existingDraftOrderId: existingBatch.draftOrderId,
        shopifyInvoiceAlreadySent: true,
        duplicateInvoicePrevented: true,
        resendEmailSkippedBecauseShopifySent: true,
        sendShopifyInvoice: false,
        skipResendEmail: true,
        workingRecipients: markRecipientEmailConfirmed(
          args.recipients,
          {
            title: args.current.productTitle,
            productId: args.current.productId,
            variantId: args.current.variantId,
          },
          normalized,
          args.current.quantity,
        ),
        batch: existingBatch,
        idempotencyKey: checkoutSessionIdempotencyKey(
          args.callSid,
          normalized,
          existingBatch.draftOrderId,
        ),
      };
    }
  }

  let batch: EmailCheckoutBatch = existingBatch
    ? registerLineToEmailBatch(existingBatch, args.current)
    : registerLineToEmailBatch(
        {
          recipientEmail: normalized,
          draftOrderId: null,
          shopifyInvoiceSent: false,
          lines: [],
          status: 'accumulating',
        },
        args.current,
      );

  const existingDraftOrderId =
    batch.draftOrderId ?? findDraftOrderIdForEmail(workingRecipients, normalized);
  const shopifyInvoiceAlreadySent =
    batch.shopifyInvoiceSent || emailPaymentLinkAlreadySent(workingRecipients, normalized);
  const idempotencyKey = checkoutSessionIdempotencyKey(
    args.callSid,
    normalized,
    existingDraftOrderId,
  );

  if (!args.finalizeCheckout) {
    return {
      aggregationMode: 'queue',
      finalizeCheckout: false,
      lines: batch.lines,
      existingDraftOrderId,
      shopifyInvoiceAlreadySent,
      duplicateInvoicePrevented: false,
      resendEmailSkippedBecauseShopifySent: false,
      sendShopifyInvoice: false,
      skipResendEmail: true,
      workingRecipients,
      batch,
      idempotencyKey,
    };
  }

  const currentFingerprint = linesFingerprint(batch.lines);
  const invoicedFingerprint = batch.invoicedLinesFingerprint ?? null;
  if (
    shopifyInvoiceAlreadySent &&
    batch.status === 'invoiced' &&
    invoicedFingerprint &&
    invoicedFingerprint === currentFingerprint
  ) {
    return {
      aggregationMode: 'duplicate_prevented',
      finalizeCheckout: true,
      lines: batch.lines,
      existingDraftOrderId,
      shopifyInvoiceAlreadySent: true,
      duplicateInvoicePrevented: true,
      resendEmailSkippedBecauseShopifySent: true,
      sendShopifyInvoice: false,
      skipResendEmail: true,
      workingRecipients,
      batch,
      idempotencyKey,
    };
  }

  if (existingDraftOrderId && shopifyInvoiceAlreadySent) {
    const linesChangedSinceInvoice =
      !invoicedFingerprint || invoicedFingerprint !== currentFingerprint;
    if (linesChangedSinceInvoice) {
      return {
        aggregationMode: 'update',
        finalizeCheckout: true,
        lines: batch.lines,
        existingDraftOrderId,
        shopifyInvoiceAlreadySent: false,
        duplicateInvoicePrevented: false,
        resendEmailSkippedBecauseShopifySent: false,
        sendShopifyInvoice: true,
        skipResendEmail: false,
        workingRecipients,
        batch,
        idempotencyKey,
      };
    }
    return {
      aggregationMode: 'update',
      finalizeCheckout: true,
      lines: batch.lines,
      existingDraftOrderId,
      shopifyInvoiceAlreadySent: true,
      duplicateInvoicePrevented: false,
      resendEmailSkippedBecauseShopifySent: true,
      sendShopifyInvoice: false,
      skipResendEmail: true,
      workingRecipients,
      batch,
      idempotencyKey,
    };
  }

  return {
    aggregationMode: existingDraftOrderId ? 'update' : 'create',
    finalizeCheckout: true,
    lines: batch.lines,
    existingDraftOrderId,
    shopifyInvoiceAlreadySent: false,
    duplicateInvoicePrevented: false,
    resendEmailSkippedBecauseShopifySent: false,
    sendShopifyInvoice: true,
    skipResendEmail: false,
    workingRecipients,
    batch,
    idempotencyKey,
  };
}

export function batchAfterSuccessfulInvoice(
  batch: EmailCheckoutBatch,
  args: { draftOrderId: string; shopifyInvoiceSent: boolean },
): EmailCheckoutBatch {
  return {
    ...batch,
    draftOrderId: args.draftOrderId,
    shopifyInvoiceSent: batch.shopifyInvoiceSent || args.shopifyInvoiceSent,
    status: 'invoiced',
    invoicedLinesFingerprint: linesFingerprint(batch.lines),
  };
}

export function sessionMetaPatchForEmailBatches(
  batches: Record<string, EmailCheckoutBatch>,
): Record<string, unknown> {
  return { [EMAIL_CHECKOUT_BATCHES_KEY]: batches };
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

/** @deprecated Use buildCheckoutExecutionPlan */
export function buildEmailCheckoutPlan(
  recipients: PaymentRecipient[],
  email: string,
  current: AggregatedCheckoutLine,
): {
  mode: 'create' | 'update';
  existingDraftOrderId: string | null;
  lines: AggregatedCheckoutLine[];
  emailAlreadySentForEmail: boolean;
  workingRecipients: PaymentRecipient[];
} {
  const plan = buildCheckoutExecutionPlan({
    recipients,
    batches: {},
    email,
    current,
    finalizeCheckout: true,
  });
  return {
    mode: plan.aggregationMode === 'update' ? 'update' : 'create',
    existingDraftOrderId: plan.existingDraftOrderId,
    lines: plan.lines,
    emailAlreadySentForEmail: plan.shopifyInvoiceAlreadySent,
    workingRecipients: plan.workingRecipients,
  };
}
