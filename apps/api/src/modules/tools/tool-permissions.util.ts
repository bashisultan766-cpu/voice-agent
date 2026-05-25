import type { AgentToolPermissions } from '@bookstore-voice-agents/types';
import { DEFAULT_TOOL_PERMISSIONS } from '@bookstore-voice-agents/types';

/** Maps each permission toggle to OpenAI tool names exposed when enabled. */
export const TOOL_PERMISSION_MAP: Record<keyof AgentToolPermissions, string[]> = {
  productCatalog: [
    'searchProducts',
    'normalizeProductQuery',
    'detectLanguage',
    'validateEmail',
    'getProductDetails',
    'getProductAvailability',
    'search_books',
    'get_book_details',
    'check_book_inventory',
    'search_collections',
    'lookup_variant',
    'validate_price',
    'check_live_inventory',
  ],
  checkoutCreation: [
    'createDraftOrder',
    'createCheckoutOrInvoicePaymentLink',
    'createCheckoutLink',
    'create_payment_checkout_link',
    'start_order_booking',
    'set_customer_details',
    'set_delivery_details',
    'confirm_order_summary',
    'captureLead',
  ],
  emailSending: ['sendPaymentEmail'],
  orderTracking: ['get_order_status'],
  refunds: ['get_return_policy'],
  discounts: ['get_promotion_details', 'lookup_discount'],
  supportEscalation: ['escalateToHuman', 'handoff_to_human', 'create_callback_request'],
  faqRetrieval: ['search_store_faqs'],
  knowledgeBase: [
    'retrieve_knowledge_base',
    'get_store_locations',
    'get_store_hours',
    'get_shipping_policy',
    'get_return_policy',
    'get_promotion_details',
    'estimate_shipping',
    'get_store_policy',
  ],
};

export function normalizeToolPermissions(
  raw: AgentToolPermissions | Record<string, unknown> | null | undefined,
): AgentToolPermissions {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TOOL_PERMISSIONS };
  const p = raw as Record<string, unknown>;
  return {
    checkoutCreation: p.checkoutCreation !== false,
    refunds: p.refunds === true,
    discounts: p.discounts !== false,
    orderTracking: p.orderTracking !== false,
    supportEscalation: p.supportEscalation !== false,
    faqRetrieval: p.faqRetrieval !== false,
    emailSending: p.emailSending !== false,
    knowledgeBase: p.knowledgeBase !== false,
    productCatalog: p.productCatalog !== false,
  };
}

/** Resolve enabled OpenAI tool names from dashboard permission toggles. */
export function toolNamesFromPermissions(permissions: AgentToolPermissions): string[] {
  const names = new Set<string>();
  for (const [key, tools] of Object.entries(TOOL_PERMISSION_MAP) as Array<
    [keyof AgentToolPermissions, string[]]
  >) {
    if (permissions[key] !== false) {
      for (const t of tools) names.add(t);
    }
  }
  return Array.from(names);
}

export function permissionsFromEnabledTools(
  enabledTools: string[] | null | undefined,
): AgentToolPermissions {
  if (!Array.isArray(enabledTools) || enabledTools.length === 0) {
    return { ...DEFAULT_TOOL_PERMISSIONS };
  }
  const set = new Set(enabledTools);
  const hasAny = (tools: string[]) => tools.some((t) => set.has(t));
  return {
    productCatalog: hasAny(TOOL_PERMISSION_MAP.productCatalog),
    checkoutCreation: hasAny(TOOL_PERMISSION_MAP.checkoutCreation),
    emailSending: hasAny(TOOL_PERMISSION_MAP.emailSending),
    orderTracking: hasAny(TOOL_PERMISSION_MAP.orderTracking),
    refunds: hasAny(TOOL_PERMISSION_MAP.refunds),
    discounts: hasAny(TOOL_PERMISSION_MAP.discounts),
    supportEscalation: hasAny(TOOL_PERMISSION_MAP.supportEscalation),
    faqRetrieval: hasAny(TOOL_PERMISSION_MAP.faqRetrieval),
    knowledgeBase: hasAny(TOOL_PERMISSION_MAP.knowledgeBase),
  };
}
