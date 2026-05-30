export type VoiceCheckoutStage =
  | 'idle'
  | 'awaiting_product_selection'
  | 'product_selected'
  | 'out_of_stock'
  | 'awaiting_email'
  | 'email_confirmation'
  | 'payment_pending'
  | 'payment_completed';

export type CheckoutProductOption = {
  id: string;
  variantId: string;
  title: string;
  price?: string;
  inStock: boolean;
};

export type VoiceCheckoutSession = {
  stage: VoiceCheckoutStage;
  candidates: CheckoutProductOption[];
  selected?: CheckoutProductOption;
  quantity: number;
  pendingEmail?: string;
  confirmedEmail?: string;
  emailConfirmationState?: 'pending' | 'confirmed' | 'rejected';
  checkoutLinkId?: string;
  checkoutUrl?: string;
  paymentLinkSent?: boolean;
  paymentStatus?: 'pending' | 'completed' | 'failed';
  emailSendAttempts: number;
  checkoutAttempts: number;
  lastError?: string;
  interruptedAt?: number;
};

export function emptyCheckoutSession(): VoiceCheckoutSession {
  return {
    stage: 'idle',
    candidates: [],
    quantity: 1,
    emailSendAttempts: 0,
    checkoutAttempts: 0,
  };
}
