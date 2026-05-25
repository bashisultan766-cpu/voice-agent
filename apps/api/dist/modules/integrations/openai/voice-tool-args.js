"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseVoiceToolArgs = parseVoiceToolArgs;
const zod_1 = require("zod");
const limitSchema = zod_1.z.coerce.number().int().min(1).max(25).optional();
const searchProductsArgs = zod_1.z.object({
    query: zod_1.z.string().min(1, 'query required'),
    limit: limitSchema,
});
const normalizeProductQueryArgs = zod_1.z.object({
    text: zod_1.z.string().min(1, 'text required'),
});
const detectLanguageArgs = zod_1.z.object({
    text: zod_1.z.string().min(1, 'text required'),
});
const validateEmailArgs = zod_1.z.object({
    email: zod_1.z.string().min(3, 'email required'),
});
const getProductDetailsArgs = zod_1.z
    .object({
    productId: zod_1.z.string().optional(),
    variantId: zod_1.z.string().optional(),
    title: zod_1.z.string().optional(),
})
    .refine((v) => Boolean(v.productId?.trim() || v.variantId?.trim() || v.title?.trim()), {
    message: 'Provide productId, variantId, or title',
});
const getProductAvailabilityArgs = zod_1.z.object({
    productId: zod_1.z.string().min(1),
    variantId: zod_1.z.string().optional(),
});
const checkoutItemSchema = zod_1.z
    .object({
    productId: zod_1.z.string().optional(),
    variantId: zod_1.z.string().optional(),
    title: zod_1.z.string().optional(),
    quantity: zod_1.z.coerce.number().min(1).max(99).optional(),
})
    .refine((v) => Boolean(v.productId?.trim() || v.variantId?.trim() || v.title?.trim()), {
    message: 'each line item needs productId, variantId, or title',
});
const createCheckoutLinkArgs = zod_1.z.object({
    email: zod_1.z.string().email('valid email required'),
    items: zod_1.z.array(checkoutItemSchema).min(1, 'at least one line item'),
    mode: zod_1.z.string().optional(),
    forceNewCheckout: zod_1.z.boolean().optional(),
});
const createDraftOrderArgs = zod_1.z.object({
    customer: zod_1.z.object({
        name: zod_1.z.string().optional(),
        phone: zod_1.z.string().optional(),
        email: zod_1.z.string().email('valid customer email required'),
    }),
    items: zod_1.z.array(checkoutItemSchema).min(1, 'at least one line item'),
});
const createCheckoutOrInvoicePaymentLinkArgs = zod_1.z.object({
    order: zod_1.z.object({
        customer: zod_1.z
            .object({
            name: zod_1.z.string().optional(),
            phone: zod_1.z.string().optional(),
            email: zod_1.z.string().email('valid customer email required'),
        })
            .optional(),
        items: zod_1.z.array(checkoutItemSchema).min(1, 'at least one line item'),
        mode: zod_1.z.string().optional(),
        forceNewCheckout: zod_1.z.boolean().optional(),
    }),
});
const sendPaymentEmailArgs = zod_1.z.object({
    email: zod_1.z.string().email(),
    checkoutLinkId: zod_1.z.string().min(1),
    items: zod_1.z.array(zod_1.z.unknown()).optional(),
});
const escalateArgs = zod_1.z.object({
    reason: zod_1.z.string().min(1, 'reason required'),
    phone: zod_1.z.string().optional(),
});
const captureLeadArgs = zod_1.z.object({
    customerName: zod_1.z.string().optional(),
    customerEmail: zod_1.z.string().optional(),
    customerPhone: zod_1.z.string().optional(),
    intent: zod_1.z.string().optional(),
    interestedItems: zod_1.z.array(zod_1.z.unknown()).optional(),
});
const searchBooksArgs = zod_1.z.object({
    query: zod_1.z.string().min(1),
    limit: limitSchema,
});
const getBookDetailsArgs = zod_1.z.object({
    productId: zod_1.z.string().min(1),
});
const checkInventoryArgs = zod_1.z
    .object({
    productId: zod_1.z.string().optional(),
    product_id: zod_1.z.string().optional(),
    title: zod_1.z.string().optional(),
    locationId: zod_1.z.string().optional(),
})
    .refine((v) => Boolean(v.productId?.trim() || v.product_id?.trim() || v.title?.trim()), {
    message: 'Provide productId, product_id, or title',
});
const orderStatusArgs = zod_1.z.object({
    orderNumber: zod_1.z.string().min(1),
    email: zod_1.z.string().optional(),
    phone: zod_1.z.string().min(3, 'phone required for verification'),
});
const startBookingArgs = zod_1.z.object({
    items: zod_1.z.array(checkoutItemSchema).min(1),
});
const setCustomerArgs = zod_1.z.object({
    name: zod_1.z.string().min(1),
    phone: zod_1.z.string().min(3),
    email: zod_1.z.string().optional(),
});
const setDeliveryArgs = zod_1.z.object({
    addressLine1: zod_1.z.string().min(1),
    city: zod_1.z.string().min(1),
    postalCode: zod_1.z.string().optional(),
    country: zod_1.z.string().optional(),
});
const confirmSummaryArgs = zod_1.z.object({
    confirmed: zod_1.z.boolean(),
});
const paymentLinkArgs = zod_1.z.object({
    channel: zod_1.z.enum(['sms', 'email']),
    destination: zod_1.z.string().min(3),
});
const faqSearchArgs = zod_1.z.object({
    query: zod_1.z.string().min(1),
    branchProfileId: zod_1.z.string().optional(),
});
const callbackArgs = zod_1.z.object({
    reason: zod_1.z.string().min(1),
    phone: zod_1.z.string().min(5),
    priority: zod_1.z.string().optional(),
    notes: zod_1.z.string().optional(),
});
const branchQueryArgs = zod_1.z.object({
    branchId: zod_1.z.string().optional(),
    city: zod_1.z.string().optional(),
});
const hoursArgs = zod_1.z.object({
    branchId: zod_1.z.string().optional(),
});
const promoArgs = zod_1.z.object({
    branchProfileId: zod_1.z.string().optional(),
});
const policyArgs = zod_1.z.object({
    branchProfileId: zod_1.z.string().optional(),
});
function parseVoiceToolArgs(toolName, raw) {
    const stripEmpty = (obj) => {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (v === undefined || v === null)
                continue;
            if (typeof v === 'string' && !v.trim())
                continue;
            out[k] = v;
        }
        return out;
    };
    const run = (schema, data) => {
        const r = schema.safeParse(data);
        if (r.success)
            return { ok: true, args: stripEmpty(r.data) };
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
//# sourceMappingURL=voice-tool-args.js.map