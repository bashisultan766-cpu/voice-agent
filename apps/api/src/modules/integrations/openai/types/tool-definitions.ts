/**
 * OpenAI Chat Completions function schemas for the Shopify voice agent.
 * `storeId` / `tenantId` are injected at runtime; the model only sends user-facing args.
 * Schemas are validated again server-side (`voice-tool-args.ts`) before execution.
 */
export type VoiceToolJsonSchema = Record<string, unknown>;

export const VOICE_AGENT_TOOLS: Array<{
  name: string;
  description: string;
  parameters: VoiceToolJsonSchema;
}> = [
  {
    name: 'searchProducts',
    description:
      'PRIMARY catalog search against the synced Shopify product cache. Use when the caller names a specific book (title), ISBN, or SKU, or asks availability/price for a concrete product. Do not call for vague “what do you sell” without a title/ISBN/SKU—answer conversationally instead. Output is authoritative—never invent products not returned.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Book title, ISBN, SKU, or keywords the caller used for one specific item.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max hits (default 8 if omitted).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'normalizeProductQuery',
    description:
      'Normalize caller product text before catalog search (trim filler words, collapse whitespace, keep important terms). Useful for noisy voice transcripts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Raw caller phrase describing a product request.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'detectLanguage',
    description:
      'Estimate caller language code from text snippet for voice adaptation. Returns best-effort result only; never invent locale-specific product facts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Caller utterance text.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'validateEmail',
    description:
      'Validate and normalize customer email before checkout or payment-link delivery.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        email: { type: 'string', description: 'Customer email address to validate.' },
      },
      required: ['email'],
    },
  },
  {
    name: 'getProductDetails',
    description:
      'Load one Shopify-backed product with variants and inventory. Call after searchProducts or when the caller names a specific item. Quote ONLY fields present in the JSON—never guess price or stock.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: { type: 'string', description: 'Shopify product GID or id from search results.' },
        variantId: { type: 'string', description: 'Preferred: variant id from search results.' },
        title: { type: 'string', description: 'Fallback disambiguation title if ids unknown.' },
      },
    },
  },
  {
    name: 'getProductAvailability',
    description:
      'Get authoritative product/variant availability and price from synced Shopify catalog cache.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: { type: 'string', description: 'Shopify product id/GID from search results.' },
        variantId: { type: 'string', description: 'Variant id/GID when caller asks about specific option.' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'createDraftOrder',
    description:
      'Create a Shopify draft-order invoice style checkout link using customer and confirmed items.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customer: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
          },
        },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              productId: { type: 'string' },
              variantId: { type: 'string' },
              title: { type: 'string' },
              quantity: { type: 'integer', minimum: 1, maximum: 99 },
            },
          },
        },
      },
      required: ['customer', 'items'],
    },
  },
  {
    name: 'createCheckoutOrInvoicePaymentLink',
    description:
      'Create a secure Shopify payment link in storefront cart or draft-order invoice mode.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        order: {
          type: 'object',
          additionalProperties: false,
          properties: {
            customer: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                phone: { type: 'string' },
                email: { type: 'string' },
              },
            },
            items: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  productId: { type: 'string' },
                  variantId: { type: 'string' },
                  title: { type: 'string' },
                  quantity: { type: 'integer', minimum: 1, maximum: 99 },
                },
              },
            },
            mode: {
              type: 'string',
              enum: ['STOREFRONT_CART', 'DRAFT_ORDER_INVOICE', 'cart', 'draft_order'],
            },
            forceNewCheckout: { type: 'boolean' },
          },
        },
      },
      required: ['order'],
    },
  },
  {
    name: 'createCheckoutLink',
    description:
      'Create a secure Shopify checkout URL AFTER the caller confirmed their email aloud. Line items MUST use variant/product ids from prior tool results. Never collect card numbers, CVV, or expiry on the phone. Omit mode to use the agent default checkout mode.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        email: { type: 'string', description: 'Customer email (already spelled back and confirmed).' },
        items: {
          type: 'array',
          minItems: 1,
          description: 'Cart lines: each entry needs variantId or productId (from tools) plus quantity.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              productId: { type: 'string' },
              variantId: { type: 'string' },
              title: { type: 'string', description: 'Disambiguation only—prefer ids from tool output.' },
              quantity: { type: 'integer', minimum: 1, maximum: 99 },
            },
          },
        },
        mode: {
          type: 'string',
          enum: ['cart', 'draft_order', 'STOREFRONT_CART', 'DRAFT_ORDER_INVOICE'],
          description: 'Optional override; otherwise agent checkout mode applies.',
        },
        forceNewCheckout: {
          type: 'boolean',
          description:
            'Set true only when the caller explicitly wants a new checkout link despite identical cart (default: reuse open checkout for this call).',
        },
      },
      required: ['email', 'items'],
    },
  },
  {
    name: 'sendPaymentEmail',
    description:
      'Email the checkout link produced by createCheckoutLink. NEVER tell the caller the email was sent until this tool returns ok:true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        email: { type: 'string', description: 'Same confirmed email as checkout.' },
        checkoutLinkId: { type: 'string', description: 'Id returned by createCheckoutLink.' },
        items: {
          type: 'array',
          description: 'Optional echo of line items for the email template.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: 'Line label shown in the email.' },
              quantity: { type: 'integer', minimum: 1, maximum: 99 },
              price: { type: 'number', description: 'Optional unit or line price for display.' },
              productId: { type: 'string', description: 'From prior catalog/checkout tool output.' },
              variantId: { type: 'string', description: 'From prior catalog/checkout tool output.' },
            },
            required: ['title', 'quantity'],
          },
        },
      },
      required: ['email', 'checkoutLinkId'],
    },
  },
  {
    name: 'escalateToHuman',
    description:
      'Queue human follow-up (callback / team alert). Use when the caller insists on a person, shows strong frustration, policy exception, or repeated tool failure. Include a concise reason string.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Short internal reason, e.g. frustrated_caller, payment_dispute.' },
        phone: { type: 'string', description: 'Optional override phone; defaults to caller id when omitted.' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'captureLead',
    description: 'Persist non-payment lead details for the sales team when checkout is not appropriate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerName: { type: 'string' },
        customerEmail: { type: 'string' },
        customerPhone: { type: 'string' },
        intent: { type: 'string' },
        interestedItems: {
          type: 'array',
          description: 'Structured items or notes from the conversation.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              quantity: { type: 'integer', minimum: 1, maximum: 99 },
              note: { type: 'string', description: 'Free-text detail when not a catalog line.' },
            },
          },
        },
      },
    },
  },
  {
    name: 'search_books',
    description:
      'LEGACY alias for catalog search—same Shopify backing as searchProducts. Prefer searchProducts when both are enabled.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_book_details',
    description: 'LEGACY detailed product fetch—same rules as getProductDetails.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: { type: 'string', description: 'Product id, variant id, handle, or exact title string.' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'check_book_inventory',
    description: 'LEGACY inventory probe—must still be grounded in Shopify tool output.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: { type: 'string' },
        product_id: { type: 'string' },
        title: { type: 'string' },
        locationId: { type: 'string', description: 'Optional retail location id.' },
      },
    },
  },
  {
    name: 'get_order_status',
    description:
      'Shopify order lookup after collecting order number AND verification phone (last-mile fraud safety). Never fabricate tracking.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        orderNumber: { type: 'string' },
        email: { type: 'string', description: 'Optional extra verifier if caller provides it.' },
        phone: { type: 'string', description: 'Caller phone used to match the order record.' },
      },
      required: ['orderNumber', 'phone'],
    },
  },
  {
    name: 'start_order_booking',
    description: 'Begin a multi-step order draft before generating a checkout link via the booking flow.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              productId: { type: 'string' },
              variantId: { type: 'string' },
              title: { type: 'string' },
              quantity: { type: 'integer', minimum: 1, maximum: 99 },
            },
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'set_customer_details',
    description: 'Persist customer identity for the booking/checkout draft.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['name', 'phone'],
    },
  },
  {
    name: 'set_delivery_details',
    description: 'Persist delivery address fields for the booking draft.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        addressLine1: { type: 'string' },
        city: { type: 'string' },
        postalCode: { type: 'string' },
        country: { type: 'string' },
      },
      required: ['addressLine1', 'city'],
    },
  },
  {
    name: 'confirm_order_summary',
    description: 'Record explicit verbal confirmation of the summarized cart.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confirmed: { type: 'boolean', description: 'true only after an explicit yes.' },
      },
      required: ['confirmed'],
    },
  },
  {
    name: 'create_payment_checkout_link',
    description:
      'Generate/send checkout for an ORDER BOOKING draft that is READY_FOR_PAYMENT. Still never collect raw card data on the phone.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: { type: 'string', enum: ['sms', 'email'] },
        destination: { type: 'string', description: 'SMS-capable phone or inbox email.' },
      },
      required: ['channel', 'destination'],
    },
  },
  {
    name: 'get_store_locations',
    description: 'Branch list / addresses from the knowledge base—not invented locations.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: { type: 'string' },
        city: { type: 'string' },
      },
    },
  },
  {
    name: 'get_store_hours',
    description: 'Structured hours from knowledge base.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: { type: 'string' },
      },
    },
  },
  {
    name: 'search_store_faqs',
    description: 'Semantic FAQ lookup—cite answers from returned snippets only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        branchProfileId: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_shipping_policy',
    description: 'Shipping policy document chunk from KB.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_return_policy',
    description: 'Return policy document chunk from KB.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_promotion_details',
    description: 'Active promotions from KB—if empty, say no promotion data is available.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchProfileId: { type: 'string' },
      },
    },
  },
  {
    name: 'create_callback_request',
    description: 'Queue a human callback when tools fail twice or the shopper needs a person.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string' },
        phone: { type: 'string', description: 'Callback number (defaults to caller id if omitted in runtime).' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        notes: { type: 'string' },
      },
      required: ['reason', 'phone'],
    },
  },
  {
    name: 'handoff_to_human',
    description: 'Immediate human escalation path—same safety rules as escalateToHuman.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'retrieve_knowledge_base',
    description:
      'RAG retrieval across uploaded FAQs, policies, and store docs. Use retrieved snippets only—never invent policy text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Caller question to match against knowledge base.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_collections',
    description: 'Search Shopify collections/categories for browsing—returns only synced catalog data.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_variant',
    description: 'Lookup a specific variant by SKU, barcode, or variant id from synced Shopify cache.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sku: { type: 'string' },
        variantId: { type: 'string' },
        productId: { type: 'string' },
      },
    },
  },
  {
    name: 'validate_price',
    description: 'Validate quoted price against live Shopify catalog—never guess prices.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: { type: 'string' },
        variantId: { type: 'string' },
        quotedPrice: { type: 'string', description: 'Price the caller mentioned.' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'check_live_inventory',
    description: 'Live inventory check via Shopify for a product/variant—authoritative stock only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: { type: 'string' },
        variantId: { type: 'string' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'lookup_discount',
    description: 'Lookup active promotions/discounts from knowledge base—if none, say no discount data available.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Optional discount code mentioned by caller.' },
      },
    },
  },
  {
    name: 'estimate_shipping',
    description: 'Shipping estimate from store policy/docs and delivery notes—not invented rates.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string' },
        country: { type: 'string' },
      },
    },
  },
  {
    name: 'get_store_policy',
    description: 'General store policy lookup (returns, shipping, exchanges) from knowledge base.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string', enum: ['shipping', 'returns', 'exchange', 'general'] },
      },
    },
  },
];

export const ALL_TOOL_NAMES = VOICE_AGENT_TOOLS.map((t) => t.name);
