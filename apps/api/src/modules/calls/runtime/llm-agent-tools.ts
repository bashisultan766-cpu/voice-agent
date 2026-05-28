import { assertAllVoiceAgentToolSchemasValid } from '../../integrations/openai/voice-tool-schema.util';

/** LLM-facing tool names exposed to OpenAI for the voice agent loop. */
export const LLM_AGENT_TOOL_NAMES = [
  'ShopifyProductSearch',
  'ShopifyProductDetails',
  'CreatePaymentLink',
  'GetOrderStatus',
  'HumanHandoff',
] as const;

export type LlmAgentToolName = (typeof LLM_AGENT_TOOL_NAMES)[number];

export type LlmAgentChatTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export const LLM_AGENT_TOOLS: LlmAgentChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'ShopifyProductSearch',
      description:
        'Search the SureShot Books Shopify catalog. Use when the caller asks for a book by title, author, category, or ISBN. Never invent products—only speak from tool results.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Search text from the caller.' },
          searchType: {
            type: 'string',
            enum: ['title', 'author', 'category', 'isbn', 'general'],
            description: 'How to interpret the query.',
          },
        },
        required: ['query', 'searchType'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ShopifyProductDetails',
      description:
        'Get authoritative price, variants, and stock for one product already found in search. Use before checkout when the caller picks a specific title.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          productId: { type: 'string', description: 'Shopify product id from search results.' },
          variantId: { type: 'string', description: 'Preferred variant id if known.' },
          title: { type: 'string', description: 'Fallback title if ids unknown.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'CreatePaymentLink',
      description:
        'Create a secure Shopify checkout link and email it after the caller confirmed product(s), quantity, and email. Never call without a valid email and variant ids from catalog tools.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          email: { type: 'string', description: 'Customer email for the payment link.' },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                variantId: { type: 'string', description: 'Shopify variant id.' },
                quantity: { type: 'integer', minimum: 1, description: 'Quantity to purchase.' },
              },
              required: ['variantId', 'quantity'],
            },
          },
        },
        required: ['email', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'GetOrderStatus',
      description:
        'Look up order status when the caller provides an order number or the email used at checkout.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderNumberOrEmail: {
            type: 'string',
            description: 'Order number or customer email from the caller.',
          },
        },
        required: ['orderNumberOrEmail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'HumanHandoff',
      description: 'Transfer to a human teammate when the caller asks for a person or the issue is out of scope.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', description: 'Brief reason for handoff.' },
        },
      },
    },
  },
];

/** Map LLM tool names to internal runtime tool names. */
export const LLM_TOOL_TO_INTERNAL: Record<LlmAgentToolName, string> = {
  ShopifyProductSearch: 'searchProducts',
  ShopifyProductDetails: 'getProductDetails',
  CreatePaymentLink: 'createCheckoutLink',
  GetOrderStatus: 'get_order_status',
  HumanHandoff: 'handoff_to_human',
};

export function mapLlmToolArgs(
  llmTool: LlmAgentToolName,
  args: Record<string, unknown>,
  ctx?: { fromNumber?: string | null },
): Record<string, unknown> {
  switch (llmTool) {
    case 'ShopifyProductSearch': {
      const query = String(args.query ?? '').trim();
      const searchType = String(args.searchType ?? 'general').toLowerCase();
      let enriched = query;
      if (searchType === 'author' && query) enriched = `author ${query}`;
      else if (searchType === 'category' && query) enriched = `${query} book`;
      else if (searchType === 'isbn' && query) enriched = query.replace(/\s+/g, '');
      return { query: enriched, limit: 3 };
    }
    case 'ShopifyProductDetails':
      return {
        productId: args.productId,
        variantId: args.variantId,
        title: args.title,
      };
    case 'CreatePaymentLink':
      return {
        email: args.email,
        items: args.items,
      };
    case 'GetOrderStatus':
      return {
        orderNumber: args.orderNumberOrEmail,
        phone: ctx?.fromNumber ?? '',
      };
    case 'HumanHandoff':
      return { reason: args.reason ?? 'customer_requested_human' };
    default:
      return args;
  }
}

export function validateLlmAgentToolSchemas(): void {
  assertAllVoiceAgentToolSchemasValid(
    LLM_AGENT_TOOLS.map((t) => ({
      name: t.function.name,
      parameters: t.function.parameters,
    })),
  );
}
