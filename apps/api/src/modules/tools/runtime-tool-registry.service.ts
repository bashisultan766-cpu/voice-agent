import { Injectable, OnModuleInit } from '@nestjs/common';
import type { AgentToolPermissions } from '@bookstore-voice-agents/types';
import { VOICE_AGENT_TOOLS, ALL_TOOL_NAMES } from '../integrations/openai/types/tool-definitions';
import { assertAllVoiceAgentToolSchemasValid } from '../integrations/openai/voice-tool-schema.util';
import {
  normalizeToolPermissions,
  toolNamesFromPermissions,
  permissionsFromEnabledTools,
} from './tool-permissions.util';

export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Permission group required (any matching enabled group grants access). */
  permissionGroups: Array<keyof AgentToolPermissions>;
}

/** Catalog metadata — schemas live in tool-definitions.ts; registry adds permission routing. */
const TOOL_PERMISSION_GROUPS: Record<string, Array<keyof AgentToolPermissions>> = {
  searchProducts: ['productCatalog'],
  normalizeProductQuery: ['productCatalog'],
  detectLanguage: ['productCatalog'],
  validateEmail: ['productCatalog', 'checkoutCreation', 'emailSending'],
  getProductDetails: ['productCatalog'],
  getProductAvailability: ['productCatalog'],
  search_books: ['productCatalog'],
  get_book_details: ['productCatalog'],
  check_book_inventory: ['productCatalog'],
  search_collections: ['productCatalog'],
  lookup_variant: ['productCatalog'],
  validate_price: ['productCatalog'],
  check_live_inventory: ['productCatalog'],
  createDraftOrder: ['checkoutCreation'],
  createCheckoutOrInvoicePaymentLink: ['checkoutCreation'],
  createCheckoutLink: ['checkoutCreation'],
  sendPaymentEmail: ['emailSending'],
  escalateToHuman: ['supportEscalation'],
  captureLead: ['checkoutCreation'],
  get_order_status: ['orderTracking'],
  search_store_faqs: ['faqRetrieval'],
  retrieve_knowledge_base: ['knowledgeBase'],
  get_store_locations: ['knowledgeBase'],
  get_store_hours: ['knowledgeBase'],
  get_shipping_policy: ['knowledgeBase'],
  get_return_policy: ['knowledgeBase', 'refunds'],
  get_promotion_details: ['discounts', 'knowledgeBase'],
  lookup_discount: ['discounts'],
  estimate_shipping: ['knowledgeBase'],
  get_store_policy: ['knowledgeBase'],
  create_callback_request: ['supportEscalation'],
  handoff_to_human: ['supportEscalation'],
  start_order_booking: ['checkoutCreation'],
  set_customer_details: ['checkoutCreation'],
  set_delivery_details: ['checkoutCreation'],
  confirm_order_summary: ['checkoutCreation'],
  create_payment_checkout_link: ['checkoutCreation'],
};

@Injectable()
export class RuntimeToolRegistryService implements OnModuleInit {
  private readonly catalog: RuntimeToolDefinition[];

  constructor() {
    this.catalog = VOICE_AGENT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      permissionGroups: TOOL_PERMISSION_GROUPS[t.name] ?? ['productCatalog'],
    }));
  }

  onModuleInit(): void {
    assertAllVoiceAgentToolSchemasValid(VOICE_AGENT_TOOLS);
  }

  getCatalog(): RuntimeToolDefinition[] {
    return this.catalog;
  }

  /**
   * Resolve tools for an agent from permission toggles and/or legacy enabledTools array.
   * Legacy enabledTools (explicit list) takes precedence when non-empty.
   */
  resolveEnabledToolNames(params: {
    toolPermissions?: AgentToolPermissions | Record<string, unknown> | null;
    enabledTools?: string[] | null;
  }): string[] {
    const { toolPermissions, enabledTools } = params;
    if (Array.isArray(enabledTools) && enabledTools.length > 0) {
      return enabledTools.filter((n) => ALL_TOOL_NAMES.includes(n));
    }
    const perms = normalizeToolPermissions(toolPermissions ?? permissionsFromEnabledTools(null));
    return toolNamesFromPermissions(perms).filter((n) => ALL_TOOL_NAMES.includes(n));
  }

  getToolsForAgent(params: {
    toolPermissions?: AgentToolPermissions | Record<string, unknown> | null;
    enabledTools?: string[] | null;
  }): ChatTool[] {
    const allowed = new Set(this.resolveEnabledToolNames(params));
    return this.catalog
      .filter((t) => allowed.has(t.name))
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  isToolAllowed(
    toolName: string,
    params: {
      toolPermissions?: AgentToolPermissions | Record<string, unknown> | null;
      enabledTools?: string[] | null;
    },
  ): boolean {
    return this.resolveEnabledToolNames(params).includes(toolName);
  }
}
