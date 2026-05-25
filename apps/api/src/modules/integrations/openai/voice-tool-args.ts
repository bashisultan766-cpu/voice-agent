import { z } from 'zod';

const limitSchema = z.coerce.number().int().min(1).max(25).optional();

const searchProductsArgs = z.object({
  query: z.string().min(1, 'query required'),
  limit: limitSchema,
});

const normalizeProductQueryArgs = z.object({
  text: z.string().min(1, 'text required'),
});

const detectLanguageArgs = z.object({
  text: z.string().min(1, 'text required'),
});

const validateEmailArgs = z.object({
  email: z.string().min(3, 'email required'),
});

const getProductDetailsArgs = z
  .object({
    productId: z.string().optional(),
    variantId: z.string().optional(),
    title: z.string().optional(),
  })
  .refine((v) => Boolean(v.productId?.trim() || v.variantId?.trim() || v.title?.trim()), {
    message: 'Provide productId, variantId, or title',
  });

const getProductAvailabilityArgs = z.object({
  productId: z.string().min(1),
  variantId: z.string().optional(),
});

const checkoutItemSchema = z
  .object({
    productId: z.string().optional(),
    variantId: z.string().optional(),
    title: z.string().optional(),
    quantity: z.coerce.number().min(1).max(99).optional(),
  })
  .refine((v) => Boolean(v.productId?.trim() || v.variantId?.trim() || v.title?.trim()), {
    message: 'each line item needs productId, variantId, or title',
  });

const createCheckoutLinkArgs = z.object({
  email: z.string().email('valid email required'),
  items: z.array(checkoutItemSchema).min(1, 'at least one line item'),
  mode: z.string().optional(),
  forceNewCheckout: z.boolean().optional(),
});

const createDraftOrderArgs = z.object({
  customer: z.object({
    name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email('valid customer email required'),
  }),
  items: z.array(checkoutItemSchema).min(1, 'at least one line item'),
});

const createCheckoutOrInvoicePaymentLinkArgs = z.object({
  order: z.object({
    customer: z
      .object({
        name: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().email('valid customer email required'),
      })
      .optional(),
    items: z.array(checkoutItemSchema).min(1, 'at least one line item'),
    mode: z.string().optional(),
    forceNewCheckout: z.boolean().optional(),
  }),
});

const sendPaymentEmailArgs = z.object({
  email: z.string().email(),
  checkoutLinkId: z.string().min(1),
  items: z.array(z.unknown()).optional(),
});

const escalateArgs = z.object({
  reason: z.string().min(1, 'reason required'),
  phone: z.string().optional(),
});

const captureLeadArgs = z.object({
  customerName: z.string().optional(),
  customerEmail: z.string().optional(),
  customerPhone: z.string().optional(),
  intent: z.string().optional(),
  interestedItems: z.array(z.unknown()).optional(),
});

const searchBooksArgs = z.object({
  query: z.string().min(1),
  limit: limitSchema,
});

const getBookDetailsArgs = z.object({
  productId: z.string().min(1),
});

const checkInventoryArgs = z
  .object({
    productId: z.string().optional(),
    product_id: z.string().optional(),
    title: z.string().optional(),
    locationId: z.string().optional(),
  })
  .refine((v) => Boolean(v.productId?.trim() || v.product_id?.trim() || v.title?.trim()), {
    message: 'Provide productId, product_id, or title',
  });

const orderStatusArgs = z.object({
  orderNumber: z.string().min(1),
  email: z.string().optional(),
  phone: z.string().min(3, 'phone required for verification'),
});

const startBookingArgs = z.object({
  items: z.array(checkoutItemSchema).min(1),
});

const setCustomerArgs = z.object({
  name: z.string().min(1),
  phone: z.string().min(3),
  email: z.string().optional(),
});

const setDeliveryArgs = z.object({
  addressLine1: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

const confirmSummaryArgs = z.object({
  confirmed: z.boolean(),
});

const paymentLinkArgs = z.object({
  channel: z.enum(['sms', 'email']),
  destination: z.string().min(3),
});

const faqSearchArgs = z.object({
  query: z.string().min(1),
  branchProfileId: z.string().optional(),
});

const callbackArgs = z.object({
  reason: z.string().min(1),
  phone: z.string().min(5),
  priority: z.string().optional(),
  notes: z.string().optional(),
});

const branchQueryArgs = z.object({
  branchId: z.string().optional(),
  city: z.string().optional(),
});

const hoursArgs = z.object({
  branchId: z.string().optional(),
});

const promoArgs = z.object({
  branchProfileId: z.string().optional(),
});

const policyArgs = z.object({
  branchProfileId: z.string().optional(),
});

export type VoiceToolArgParse =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string; field?: string };

/**
 * Strict, deterministic parsing of model-supplied tool arguments before execution.
 * Invalid shapes never reach Shopify or checkout paths.
 */
export function parseVoiceToolArgs(toolName: string, raw: Record<string, unknown>): VoiceToolArgParse {
  const stripEmpty = (obj: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' && !v.trim()) continue;
      out[k] = v;
    }
    return out;
  };

  const run = <T>(schema: z.ZodType<T>, data: Record<string, unknown>): VoiceToolArgParse => {
    const r = schema.safeParse(data);
    if (r.success) return { ok: true, args: stripEmpty(r.data as unknown as Record<string, unknown>) };
    const issue = r.error.issues[0];
    return {
      ok: false,
      message: issue?.message ?? 'Invalid tool arguments',
      field: issue?.path?.join('.'),
    };
  };

  switch (toolName) {
    case 'normalizeProductQuery':
      return run(normalizeProductQueryArgs, raw);
    case 'detectLanguage':
      return run(detectLanguageArgs, raw);
    case 'validateEmail':
      return run(validateEmailArgs, raw);
    case 'searchProducts':
      return run(searchProductsArgs, raw);
    case 'getProductDetails':
      return run(getProductDetailsArgs, raw);
    case 'getProductAvailability':
      return run(getProductAvailabilityArgs, raw);
    case 'createCheckoutLink':
      return run(createCheckoutLinkArgs, raw);
    case 'createDraftOrder':
      return run(createDraftOrderArgs, raw);
    case 'createCheckoutOrInvoicePaymentLink':
      return run(createCheckoutOrInvoicePaymentLinkArgs, raw);
    case 'sendPaymentEmail':
      return run(sendPaymentEmailArgs, raw);
    case 'escalateToHuman':
    case 'handoff_to_human':
      return run(escalateArgs, raw);
    case 'captureLead':
      return run(captureLeadArgs, raw);
    case 'search_books':
      return run(searchBooksArgs, raw);
    case 'get_book_details':
      return run(getBookDetailsArgs, raw);
    case 'check_book_inventory':
      return run(checkInventoryArgs, raw);
    case 'get_order_status':
      return run(orderStatusArgs, raw);
    case 'start_order_booking':
      return run(startBookingArgs, raw);
    case 'set_customer_details':
      return run(setCustomerArgs, raw);
    case 'set_delivery_details':
      return run(setDeliveryArgs, raw);
    case 'confirm_order_summary':
      return run(confirmSummaryArgs, raw);
    case 'create_payment_checkout_link':
      return run(paymentLinkArgs, raw);
    case 'search_store_faqs':
      return run(faqSearchArgs, raw);
    case 'create_callback_request':
      return run(callbackArgs, raw);
    case 'get_store_locations':
      return run(branchQueryArgs, raw);
    case 'get_store_hours':
      return run(hoursArgs, raw);
    case 'get_promotion_details':
      return run(promoArgs, raw);
    case 'get_shipping_policy':
    case 'get_return_policy':
      return run(policyArgs, raw);
    case 'retrieve_knowledge_base':
    case 'search_collections':
    case 'lookup_variant':
    case 'validate_price':
    case 'check_live_inventory':
    case 'lookup_discount':
    case 'estimate_shipping':
    case 'get_store_policy':
      return { ok: true, args: raw };
    default:
      return { ok: false, message: `Unsupported tool: ${toolName}` };
  }
}
