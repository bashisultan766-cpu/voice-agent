/** Service-layer input for sendPaymentLink (controller maps HTTP/tool body → this). */
export type SendPaymentLinkInput = {
  email: string;
  quantity?: number;
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
   * false — queue this book on the call/email batch (no invoice yet).
   * true — create/update one draft order and send one invoice email for all queued books.
   * omitted — auto: finalize the first book only; queue additional books until explicit true.
   */
  finalizeCheckout?: boolean;
};
