/** Per product/email payment link on a single call session. */
export type PaymentRecipientStatus =
  | 'pending'
  | 'email_pending'
  | 'email_confirmed'
  | 'link_created'
  | 'link_sent'
  | 'failed';

export type PaymentRecipient = {
  productId: string;
  productTitle: string;
  variantId?: string;
  recipientEmail: string;
  paymentLink?: string | null;
  paymentStatus: PaymentRecipientStatus;
  draftOrderId?: string | null;
  checkoutLinkId?: string | null;
  quantity?: number;
};

export const PAYMENT_RECIPIENTS_METADATA_KEY = 'paymentRecipients';
export const PAYMENT_RECIPIENTS_STATE_KEY = 'paymentRecipients';
