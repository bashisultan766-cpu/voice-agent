import { createHash } from 'crypto';
import { normalizeSpokenEmail } from './spoken-email-normalizer.util';
import type { LlmAgentConversationState, LlmSelectedProduct } from './llm-agent-conversation-state.util';
import {
  PAYMENT_RECIPIENTS_METADATA_KEY,
  PAYMENT_RECIPIENTS_STATE_KEY,
  type PaymentRecipient,
  type PaymentRecipientStatus,
} from './payment-recipient.types';

export {
  PAYMENT_RECIPIENTS_METADATA_KEY,
  PAYMENT_RECIPIENTS_STATE_KEY,
  type PaymentRecipient,
  type PaymentRecipientStatus,
} from './payment-recipient.types';

export function normalizeRecipientEmail(email: string): string {
  return normalizeSpokenEmail(email).trim().toLowerCase();
}

export function paymentRecipientPairKey(productId: string, recipientEmail: string): string {
  const pid = productId.trim().toLowerCase();
  const em = normalizeRecipientEmail(recipientEmail);
  return createHash('sha256').update(`${pid}|${em}`, 'utf8').digest('hex');
}

export function parsePaymentRecipients(raw: unknown): PaymentRecipient[] {
  if (!Array.isArray(raw)) return [];
  const out: PaymentRecipient[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const o = row as Record<string, unknown>;
    const productId = typeof o.productId === 'string' ? o.productId.trim() : '';
    const productTitle = typeof o.productTitle === 'string' ? o.productTitle.trim() : '';
    const recipientEmail =
      typeof o.recipientEmail === 'string' ? normalizeRecipientEmail(o.recipientEmail) : '';
    const paymentStatus = o.paymentStatus;
    if (!productId || !productTitle || !recipientEmail) continue;
    if (
      paymentStatus !== 'pending' &&
      paymentStatus !== 'email_pending' &&
      paymentStatus !== 'email_confirmed' &&
      paymentStatus !== 'link_created' &&
      paymentStatus !== 'link_sent' &&
      paymentStatus !== 'failed'
    ) {
      continue;
    }
    out.push({
      productId,
      productTitle,
      variantId: typeof o.variantId === 'string' ? o.variantId : undefined,
      recipientEmail,
      paymentLink: typeof o.paymentLink === 'string' ? o.paymentLink : null,
      paymentStatus,
      draftOrderId: typeof o.draftOrderId === 'string' ? o.draftOrderId : null,
      checkoutLinkId: typeof o.checkoutLinkId === 'string' ? o.checkoutLinkId : null,
      quantity: typeof o.quantity === 'number' ? Math.max(1, Math.trunc(o.quantity)) : undefined,
    });
  }
  return out;
}

export function paymentRecipientsFromSession(
  metadata: Record<string, unknown>,
  llmState?: LlmAgentConversationState,
): PaymentRecipient[] {
  const fromMeta = parsePaymentRecipients(metadata[PAYMENT_RECIPIENTS_METADATA_KEY]);
  if (fromMeta.length) return fromMeta;
  return parsePaymentRecipients(llmState?.paymentRecipients);
}

export function isMultiRecipientSession(recipients: PaymentRecipient[]): boolean {
  return recipients.length > 0;
}

export function findPaymentRecipient(
  recipients: PaymentRecipient[],
  productId: string,
  recipientEmail: string,
): PaymentRecipient | undefined {
  const key = paymentRecipientPairKey(productId, recipientEmail);
  return recipients.find((r) => paymentRecipientPairKey(r.productId, r.recipientEmail) === key);
}

export function isDuplicatePaymentRecipient(
  recipients: PaymentRecipient[],
  productId: string,
  recipientEmail: string,
  options?: { allowResend?: boolean },
): boolean {
  const existing = findPaymentRecipient(recipients, productId, recipientEmail);
  if (!existing) return false;
  if (options?.allowResend) return false;
  return existing.paymentStatus === 'link_sent' || existing.paymentStatus === 'link_created';
}

export function resolveProductIdForRecipient(product: LlmSelectedProduct): string {
  return (product.productId ?? product.variantId ?? product.title).trim();
}

export function upsertPaymentRecipient(
  recipients: PaymentRecipient[],
  patch: PaymentRecipient,
): PaymentRecipient[] {
  const key = paymentRecipientPairKey(patch.productId, patch.recipientEmail);
  const next = recipients.filter(
    (r) => paymentRecipientPairKey(r.productId, r.recipientEmail) !== key,
  );
  next.push(patch);
  return next;
}

export function markRecipientEmailConfirmed(
  recipients: PaymentRecipient[],
  product: LlmSelectedProduct,
  email: string,
  quantity: number,
): PaymentRecipient[] {
  const productId = resolveProductIdForRecipient(product);
  return upsertPaymentRecipient(recipients, {
    productId,
    productTitle: product.title,
    variantId: product.variantId,
    recipientEmail: normalizeRecipientEmail(email),
    paymentStatus: 'email_confirmed',
    quantity: Math.max(1, quantity),
    paymentLink: null,
  });
}

export function markRecipientPaymentSent(
  recipients: PaymentRecipient[],
  productId: string,
  recipientEmail: string,
  args: {
    paymentLink?: string;
    draftOrderId?: string;
    checkoutLinkId?: string;
    productTitle?: string;
    variantId?: string;
    quantity?: number;
  },
): PaymentRecipient[] {
  const existing = findPaymentRecipient(recipients, productId, recipientEmail);
  const base: PaymentRecipient = existing ?? {
    productId,
    productTitle: args.productTitle?.trim() || productId,
    variantId: args.variantId,
    recipientEmail: normalizeRecipientEmail(recipientEmail),
    paymentStatus: 'email_confirmed',
    quantity: args.quantity,
  };
  return upsertPaymentRecipient(recipients, {
    ...base,
    paymentStatus: 'link_sent',
    paymentLink: args.paymentLink ?? base.paymentLink ?? null,
    draftOrderId: args.draftOrderId ?? base.draftOrderId ?? null,
    checkoutLinkId: args.checkoutLinkId ?? base.checkoutLinkId ?? null,
    variantId: args.variantId ?? base.variantId,
    quantity: args.quantity ?? base.quantity,
  });
}

export function recipientHasSentLink(
  recipients: PaymentRecipient[],
  productId: string,
  recipientEmail?: string,
): boolean {
  if (recipientEmail) {
    const r = findPaymentRecipient(recipients, productId, recipientEmail);
    return r?.paymentStatus === 'link_sent' || r?.paymentStatus === 'link_created';
  }
  return recipients.some(
    (r) =>
      r.productId === productId &&
      (r.paymentStatus === 'link_sent' || r.paymentStatus === 'link_created'),
  );
}

export function allPaymentRecipientsTerminal(recipients: PaymentRecipient[]): boolean {
  if (!recipients.length) return false;
  return recipients.every(
    (r) => r.paymentStatus === 'link_sent' || r.paymentStatus === 'failed',
  );
}

export function wantsAnotherBookOnCall(utterance: string): boolean {
  return /\b(another book|different book|one more book|also want|also like|add another|second book|third book|more books?)\b/i.test(
    utterance,
  );
}

export function isLegacySingleRecipientComplete(
  recipients: PaymentRecipient[],
  paymentLinkSent: boolean,
  orderState?: string | null,
): boolean {
  if (isMultiRecipientSession(recipients)) {
    return allPaymentRecipientsTerminal(recipients);
  }
  return paymentLinkSent || orderState === 'PAYMENT_LINK_SENT';
}

export function shouldBlockPostPaymentEmailCapture(args: {
  utterance: string;
  recipients: PaymentRecipient[];
  paymentLinkSent: boolean;
  orderState?: string | null;
}): boolean {
  if (!isLegacySingleRecipientComplete(args.recipients, args.paymentLinkSent, args.orderState)) {
    return false;
  }
  if (wantsAnotherBookOnCall(args.utterance)) return false;
  return Boolean(extractEmailFromUtterance(args.utterance));
}

function extractEmailFromUtterance(utterance: string): string | null {
  if (!/@/.test(utterance) && !/\b(at|dot)\s+\w+/i.test(utterance)) return null;
  return utterance;
}

export function buildPaymentRecipientsSummary(recipients: PaymentRecipient[]): string {
  const sent = recipients.filter((r) => r.paymentStatus === 'link_sent');
  if (!sent.length) return '';
  const lines = sent.map(
    (r, i) =>
      `${i + 1}. ${r.productTitle} — payment link sent to ${maskRecipientEmail(r.recipientEmail)}.`,
  );
  return `Here's a summary of your payment links: ${lines.join(' ')} Is there anything else I can help you with?`;
}

function maskRecipientEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return 'your email';
  const visible = local.length <= 2 ? local[0] ?? '*' : `${local.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}

export function mergePaymentRecipientsIntoState(
  state: LlmAgentConversationState,
  recipients: PaymentRecipient[],
): LlmAgentConversationState {
  return {
    ...state,
    paymentRecipients: recipients,
    paymentLinkSent: recipients.some((r) => r.paymentStatus === 'link_sent'),
  };
}

export function sessionMetaPatchForRecipients(recipients: PaymentRecipient[]): Record<string, unknown> {
  return { [PAYMENT_RECIPIENTS_METADATA_KEY]: recipients };
}

export function resetPerProductEmailForNextBook(): Record<string, unknown> {
  return {
    normalizedEmail: null,
    emailConfirmationState: 'none',
    orderState: 'PRODUCT_CONFIRMED',
  };
}

export function activeProductAlreadySent(
  recipients: PaymentRecipient[],
  product: LlmSelectedProduct | undefined,
  email?: string | null,
): boolean {
  if (!product) return false;
  const productId = resolveProductIdForRecipient(product);
  if (email?.trim()) {
    return recipientHasSentLink(recipients, productId, email);
  }
  const variantId = product.variantId?.trim();
  if (!variantId) return false;
  const match = recipients.find(
    (r) =>
      r.variantId === variantId &&
      (r.paymentStatus === 'link_sent' || r.paymentStatus === 'link_created'),
  );
  return Boolean(match);
}
