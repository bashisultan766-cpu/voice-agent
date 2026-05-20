import assert from 'node:assert/strict';
import { ShopifyProductSyncService } from '../modules/integrations/shopify/product-sync';
import { ShopifyProductSearchService } from '../modules/integrations/shopify/product-search';
import { ShopifyCartCheckoutService } from '../modules/integrations/shopify/cart-checkout';
import { ShopifyDraftOrderService } from '../modules/integrations/shopify/draft-order';
import { ShopifyCheckoutService } from '../modules/integrations/shopify/shopify-checkout.service';
import {
  ShopifyCheckoutValidationError,
  ShopifyGraphqlError,
  ShopifyRestError,
  formatShopifyErrorForCaller,
} from '../modules/integrations/shopify/shopify-errors';

type JsonObj = Record<string, unknown>;

function logOk(name: string) {
  // eslint-disable-next-line no-console
  console.log(`OK: ${name}`);
}

async function testProductSyncHandlesVariants() {
  const upsertedVariants: string[] = [];
  const fakePrisma = {
    productCache: {
      upsert: async ({ create }: { create: JsonObj }) => ({ id: 'pc_1', ...create }),
    },
    variantCache: {
      upsert: async ({ create }: { create: JsonObj }) => {
        upsertedVariants.push(String(create.shopifyVariantId));
        return { id: `vc_${upsertedVariants.length}`, ...create };
      },
      deleteMany: async () => ({ count: 0 }),
    },
  };
  const fakeClient = {
    getAgentShopifyConfig: async () => ({ domain: 'demo.myshopify.com', token: 'tok' }),
    adminGraphql: async (_domain: string, _token: string, query: string, vars: JsonObj) => {
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
      const after = (vars.after as string | null) ?? null;
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

  const svc = new ShopifyProductSyncService(fakePrisma as never, fakeClient as never);
  const res = await svc.syncProducts('tenant_1', 'agent_1');
  assert.equal(res.syncedProducts, 1);
  assert.equal(res.syncedVariants, 2);
  assert.deepEqual(upsertedVariants.sort(), [
    'gid://shopify/ProductVariant/100',
    'gid://shopify/ProductVariant/101',
  ]);
  logOk('Product sync handles variant pagination');
}

async function testSearchWorksByTitleSkuHandle() {
  let capturedWhere: JsonObj | null = null;
  const fakePrisma = {
    productCache: {
      findMany: async ({ where }: { where: JsonObj }) => {
        capturedWhere = where;
        return [];
      },
      findFirst: async () => null,
    },
  };
  const svc = new ShopifyProductSearchService(fakePrisma as never);
  await svc.search('tenant_1', 'alpha', 8, 'demo.myshopify.com');
  const where = JSON.stringify(capturedWhere ?? {});
  assert.match(where, /"title"/);
  assert.match(where, /"handle"/);
  assert.match(where, /"sku"/);
  logOk('Search includes title, SKU, and handle matching');
}

async function testCartCheckoutWorks() {
  const fakePrisma = {
    checkoutLink: {
      create: async ({ data }: { data: JsonObj }) => ({ id: 'chk_1', ...data }),
    },
  };
  const fakeClient = {
    getAgentShopifyConfig: async () => ({
      domain: 'demo.myshopify.com',
      token: 'tok',
      shopifyConnectionId: 'sc_1',
    }),
  };
  const svc = new ShopifyCartCheckoutService(fakePrisma as never, fakeClient as never);
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
  assert.equal(out.mode, 'STOREFRONT_CART');
  assert.match(out.checkoutUrl, /^https:\/\/demo\.myshopify\.com\/cart\/100:2\?checkout\[email\]=buyer%40example\.com/);
  logOk('Storefront cart checkout link is created');
}

async function testDraftInvoiceWorks() {
  const fakePrisma = {
    checkoutLink: {
      create: async ({ data }: { data: JsonObj }) => ({ id: 'chk_draft', ...data }),
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
  const svc = new ShopifyDraftOrderService(fakePrisma as never, fakeClient as never);
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
  assert.equal(out.mode, 'DRAFT_ORDER_INVOICE');
  assert.equal(out.providerRef, 'gid://shopify/DraftOrder/1');
  logOk('Draft order invoice link is created');
}

async function testCheckoutMetadataSaved() {
  let metadataSeen: JsonObj | null = null;
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
    createStorefrontCartCheckout: async (_t: string, _a: string, payload: { metadata: JsonObj }) => {
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
  const svc = new ShopifyCheckoutService(
    fakePrisma as never,
    fakeClient as never,
    fakeCart as never,
    fakeDraft as never,
  );
  await svc.createCheckoutLink('tenant_1', 'agent_1', {
    customer: { email: 'buyer@example.com' },
    items: [{ variantId: 'gid://shopify/ProductVariant/100', quantity: 1 }],
  });
  const asJson = JSON.stringify(metadataSeen ?? {});
  assert.match(asJson, /shopDomain/);
  assert.match(asJson, /flow/);
  assert.match(asJson, /lineCount/);
  logOk('Checkout metadata is saved on link creation');
}

async function testShopifyErrorsHandled() {
  const gqlRetryable = new ShopifyGraphqlError(
    'throttled',
    [{ message: 'Too many requests', extensions: { code: 'THROTTLED' } }],
    429,
  );
  const restFatal = new ShopifyRestError('bad request', 400);
  const validation = new ShopifyCheckoutValidationError('NO_LINE_ITEMS', 'Need line items.');

  assert.match(formatShopifyErrorForCaller(gqlRetryable), /temporary limit/i);
  assert.match(formatShopifyErrorForCaller(restFatal), /Shopify returned an error/i);
  assert.equal(formatShopifyErrorForCaller(validation), 'Need line items.');
  logOk('Shopify error mapping returns caller-safe messages');
}

async function main() {
  await testProductSyncHandlesVariants();
  await testSearchWorksByTitleSkuHandle();
  await testCartCheckoutWorks();
  await testDraftInvoiceWorks();
  await testCheckoutMetadataSaved();
  await testShopifyErrorsHandled();
  // eslint-disable-next-line no-console
  console.log('All Shopify runtime smoke checks passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Shopify smoke checks failed:', err);
  process.exit(1);
});
