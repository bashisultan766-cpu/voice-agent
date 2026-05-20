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
export declare function toCheckoutModeApi(mode: CheckoutModeInput | null | undefined): CheckoutModeApi;
export declare function toCheckoutModeForm(mode: CheckoutModeInput | null | undefined): CheckoutModeForm;
export declare function checkoutModeDescription(mode: string | null | undefined): string;
/** Match Shopify client / product sync normalization. */
export declare function normalizeShopifyDomain(rawUrl: string | null | undefined): string | null;
//# sourceMappingURL=voice-agent.d.ts.map