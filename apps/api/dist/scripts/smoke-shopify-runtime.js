"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = require("node:assert/strict");
const product_sync_1 = require("../modules/integrations/shopify/product-sync");
const product_search_1 = require("../modules/integrations/shopify/product-search");
const cart_checkout_1 = require("../modules/integrations/shopify/cart-checkout");
const draft_order_1 = require("../modules/integrations/shopify/draft-order");
const shopify_checkout_service_1 = require("../modules/integrations/shopify/shopify-checkout.service");
const shopify_errors_1 = require("../modules/integrations/shopify/shopify-errors");
function logOk(name) {
    console.log(`OK: ${name}`);
}
async function testProductSyncHandlesVariants() {
    const upsertedVariants = [];
    const fakePrisma = {
        productCache: {
            upsert: async ({ create }) => ({ id: 'pc_1', ...create }),
        },
        variantCache: {
            upsert: async ({ create }) => {
                upsertedVariants.push(String(create.shopifyVariantId));
                return { id: `vc_${upsertedVariants.length}`, ...create };
            },
            deleteMany: async () => ({ count: 0 }),
        },
    };
    const fakeClient = {
        getAgentShopifyConfig: async () => ({ domain: 'demo.myshopify.com', token: 'tok' }),
        adminGraphql: async (_domain, _token, query, vars) => {
            if (query.includes('products(')) {
                return {
                    products: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [
                            {
                                id: 'gid://shopify/Product/10',
                                title: 'Sample Product',
                                handle: 'sample-product',
                                vendor: 'Demo',
                                productType: 'Books',
                                status: 'ACTIVE',
                                tags: ['new'],
                            },
                        ],
                    },
                };
            }
            const after = vars.after ?? null;
            if (!after) {
                return {
                    product: {
                        id: 'gid://shopify/Product/10',
                        variants: {
                            pageInfo: { hasNextPage: true, endCursor: 'cursor_2' },
                            nodes: [
                                {
                                    id: 'gid://shopify/ProductVariant/100',
                                    title: 'Default',
                                    sku: 'SKU-100',
                                    price: '10.00',
                                    compareAtPrice: null,
                                    inventoryQuantity: 3,
                                    availableForSale: true,
                                },
                            ],
                        },
                    },
                };
            }
            return {
                product: {
                    id: 'gid://shopify/Product/10',
                    variants: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [
                            {
                                id: 'gid://shopify/ProductVariant/101',
                                title: 'Large',
                                sku: 'SKU-101',
                                price: '12.00',
                                compareAtPrice: null,
                                inventoryQuantity: 1,
                                availableForSale: true,
                            },
                        ],
                    },
                },
            };
        },
    };
    const svc = new product_sync_1.ShopifyProductSyncService(fakePrisma, fakeClient);
    const res = await svc.syncProducts('tenant_1', 'agent_1');
    strict_1.default.equal(res.syncedProducts, 1);
    strict_1.default.equal(res.syncedVariants, 2);
    strict_1.default.deepEqual(upsertedVariants.sort(), [
        'gid://shopify/ProductVariant/100',
        'gid://shopify/ProductVariant/101',
    ]);
    logOk('Product sync handles variant pagination');
}
async function testSearchWorksByTitleSkuHandle() {
    let capturedWhere = null;
    const fakePrisma = {
        productCache: {
            findMany: async ({ where }) => {
                capturedWhere = where;
                return [];
            },
            findFirst: async () => null,
        },
    };
    const svc = new product_search_1.ShopifyProductSearchService(fakePrisma);
    await svc.search('tenant_1', 'alpha', 8, 'demo.myshopify.com');
    const where = JSON.stringify(capturedWhere ?? {});
    strict_1.default.match(where, /"title"/);
    strict_1.default.match(where, /"handle"/);
    strict_1.default.match(where, /"sku"/);
    logOk('Search includes title, SKU, and handle matching');
}
async function testCartCheckoutWorks() {
    const fakePrisma = {
        checkoutLink: {
            create: async ({ data }) => ({ id: 'chk_1', ...data }),
        },
    };
    const fakeClient = {
        getAgentShopifyConfig: async () => ({
            domain: 'demo.myshopify.com',
            token: 'tok',
            shopifyConnectionId: 'sc_1',
        }),
    };
    const svc = new cart_checkout_1.ShopifyCartCheckoutService(fakePrisma, fakeClient);
    const out = await svc.createStorefrontCartCheckout('tenant_1', 'agent_1', {
        email: 'buyer@example.com',
        lines: [
            {
                variantGid: 'gid://shopify/ProductVariant/100',
                storefrontVariantId: '100',
                quantity: 2,
            },
        ],
        checkoutFingerprint: 'fp_1',
        metadata: { source: 'smoke' },
    });
    strict_1.default.equal(out.mode, 'STOREFRONT_CART');
    strict_1.default.match(out.checkoutUrl, /^https:\/\/demo\.myshopify\.com\/cart\/100:2\?checkout\[email\]=buyer%40example\.com/);
    logOk('Storefront cart checkout link is created');
}
async function testDraftInvoiceWorks() {
    const fakePrisma = {
        checkoutLink: {
            create: async ({ data }) => ({ id: 'chk_draft', ...data }),
        },
    };
    const fakeClient = {
        getAgentShopifyConfig: async () => ({
            domain: 'demo.myshopify.com',
            token: 'tok',
            shopifyConnectionId: 'sc_1',
        }),
        adminGraphql: async () => ({
            draftOrderCreate: {
                draftOrder: {
                    id: 'gid://shopify/DraftOrder/1',
                    invoiceUrl: 'https://demo.myshopify.com/invoice/1',
                },
                userErrors: [],
            },
        }),
    };
    const svc = new draft_order_1.ShopifyDraftOrderService(fakePrisma, fakeClient);
    const out = await svc.createDraftOrderCheckout('tenant_1', 'agent_1', {
        email: 'buyer@example.com',
        lines: [
            {
                variantGid: 'gid://shopify/ProductVariant/100',
                storefrontVariantId: '100',
                quantity: 1,
            },
        ],
        checkoutFingerprint: 'fp_2',
        metadata: { source: 'smoke' },
    });
    strict_1.default.equal(out.mode, 'DRAFT_ORDER_INVOICE');
    strict_1.default.equal(out.providerRef, 'gid://shopify/DraftOrder/1');
    logOk('Draft order invoice link is created');
}
async function testCheckoutMetadataSaved() {
    let metadataSeen = null;
    const fakePrisma = {
        agentConfig: { findUnique: async () => ({ checkoutMode: 'STOREFRONT_CART' }) },
        checkoutLink: { findFirst: async () => null },
        variantCache: {
            findFirst: async () => ({
                shopifyVariantId: 'gid://shopify/ProductVariant/100',
                title: 'Default Title',
                sku: 'SKU-100',
                availableForSale: true,
                inventoryQuantity: 10,
                product: { title: 'Sample Product', shopifyProductId: 'gid://shopify/Product/10' },
            }),
        },
    };
    const fakeClient = {
        getAgentShopifyConfig: async () => ({
            domain: 'demo.myshopify.com',
            token: 'tok',
            shopifyConnectionId: 'sc_1',
        }),
    };
    const fakeCart = {
        createStorefrontCartCheckout: async (_t, _a, payload) => {
            metadataSeen = payload.metadata;
            return {
                id: 'chk_3',
                mode: 'STOREFRONT_CART',
                checkoutUrl: 'https://demo.myshopify.com/cart',
            };
        },
    };
    const fakeDraft = {
        createDraftOrderCheckout: async () => {
            throw new Error('should not be called');
        },
    };
    const svc = new shopify_checkout_service_1.ShopifyCheckoutService(fakePrisma, fakeClient, fakeCart, fakeDraft);
    await svc.createCheckoutLink('tenant_1', 'agent_1', {
        customer: { email: 'buyer@example.com' },
        items: [{ variantId: 'gid://shopify/ProductVariant/100', quantity: 1 }],
    });
    const asJson = JSON.stringify(metadataSeen ?? {});
    strict_1.default.match(asJson, /shopDomain/);
    strict_1.default.match(asJson, /flow/);
    strict_1.default.match(asJson, /lineCount/);
    logOk('Checkout metadata is saved on link creation');
}
async function testShopifyErrorsHandled() {
    const gqlRetryable = new shopify_errors_1.ShopifyGraphqlError('throttled', [{ message: 'Too many requests', extensions: { code: 'THROTTLED' } }], 429);
    const restFatal = new shopify_errors_1.ShopifyRestError('bad request', 400);
    const validation = new shopify_errors_1.ShopifyCheckoutValidationError('NO_LINE_ITEMS', 'Need line items.');
    strict_1.default.match((0, shopify_errors_1.formatShopifyErrorForCaller)(gqlRetryable), /temporary limit/i);
    strict_1.default.match((0, shopify_errors_1.formatShopifyErrorForCaller)(restFatal), /Shopify returned an error/i);
    strict_1.default.equal((0, shopify_errors_1.formatShopifyErrorForCaller)(validation), 'Need line items.');
    logOk('Shopify error mapping returns caller-safe messages');
}
async function main() {
    await testProductSyncHandlesVariants();
    await testSearchWorksByTitleSkuHandle();
    await testCartCheckoutWorks();
    await testDraftInvoiceWorks();
    await testCheckoutMetadataSaved();
    await testShopifyErrorsHandled();
    console.log('All Shopify runtime smoke checks passed.');
}
main().catch((err) => {
    console.error('Shopify smoke checks failed:', err);
    process.exit(1);
});
//# sourceMappingURL=smoke-shopify-runtime.js.map