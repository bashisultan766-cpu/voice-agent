/** Service-layer input for sendPaymentLink (controller maps HTTP/tool body → this). */
export type SendPaymentLinkInput = {
  email: string;
  quantity: number;
  /** Explicit Shopify variant; used when present and valid. */
  variantId?: string;
  /** Book title / search query — triggers automatic search-product when variantId is absent. */
  productName?: string;
  phoneNumber?: string;
  callSid?: string;
  tenantId?: string;
  agentId?: string;
  emailConfirmed?: boolean;
  /**
   * When false (default), queue the product for the call/email batch without creating a draft order.
   * When true, finalize the batch: one draft order, one Shopify invoice, optional Resend fallback.
   */
  finalizeCheckout?: boolean;
};
