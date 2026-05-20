/**
 * Non-secret agent config snapshot used when building voice runtime context and prompts.
 * Kept in sync with Prisma `AgentConfig` fields exposed to the model (no metadata blob).
 */
export interface VoiceAgentRuntimeConfig {
  businessName?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  shippingPolicy?: string | null;
  returnPolicy?: string | null;
  exchangePolicy?: string | null;
  deliveryNotes?: string | null;
  escalationRules?: string | null;
  forbiddenBehaviors?: string | null;
  checkoutMode?: CheckoutModeApi | CheckoutModeInput | null;
  askEmailBeforePaymentLink?: boolean | null;
  fallbackHumanContact?: string | null;
  /** Wizard / dashboard copy; may mirror `Agent.baseSystemPrompt`. */
  customSystemPrompt?: string | null;
  humanHandoffRules?: string | null;
}

export type CheckoutModeApi = 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
export type CheckoutModeForm = 'cart' | 'draft_order';
export type CheckoutModeInput = CheckoutModeApi | CheckoutModeForm | 'DRAFT_ORDER' | string;

export function toCheckoutModeApi(mode: CheckoutModeInput | null | undefined): CheckoutModeApi {
  if (!mode) return 'STOREFRONT_CART';
  const value = String(mode).trim().toUpperCase();
  return value === 'DRAFT_ORDER_INVOICE' || value === 'DRAFT_ORDER'
    ? 'DRAFT_ORDER_INVOICE'
    : 'STOREFRONT_CART';
}

export function toCheckoutModeForm(mode: CheckoutModeInput | null | undefined): CheckoutModeForm {
  return toCheckoutModeApi(mode) === 'DRAFT_ORDER_INVOICE' ? 'draft_order' : 'cart';
}

export function checkoutModeDescription(mode: string | null | undefined): string {
  if (toCheckoutModeApi(mode) === 'DRAFT_ORDER_INVOICE') {
    return 'Use draft-order invoice checkout (admin draft order + invoice URL) when creating payment links unless the caller needs a standard storefront cart link.';
  }
  return 'Use storefront cart permalink checkout (default cart flow) when creating payment links.';
}

/** Match Shopify client / product sync normalization. */
export function normalizeShopifyDomain(rawUrl: string | null | undefined): string | null {
  if (!rawUrl?.trim()) return null;
  return rawUrl
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}
