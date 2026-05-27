"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ShopifyProductSyncService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyProductSyncService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const client_1 = require("./client");
const shopify_errors_1 = require("./shopify-errors");
const PRODUCTS_PAGE_SIZE = Math.min(Math.max(Number(process.env.SHOPIFY_SYNC_PRODUCTS_PAGE) || 50, 1), 100);
const VARIANTS_PAGE_SIZE = Math.min(Math.max(Number(process.env.SHOPIFY_SYNC_VARIANTS_PAGE) || 100, 1), 250);
const SYNC_THROTTLE_MS = Math.max(Number(process.env.SHOPIFY_SYNC_THROTTLE_MS) || 0, 0);
const MAX_PRODUCT_SYNC_PAGES = Math.max(Number(process.env.SHOPIFY_SYNC_MAX_PRODUCT_PAGES) || 500, 1);
const MAX_VARIANT_SYNC_PAGES = Math.max(Number(process.env.SHOPIFY_SYNC_MAX_VARIANT_PAGES) || 500, 1);
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function variantPriceStrings(variant) {
    const pv2 = variant.priceV2;
    const cv2 = variant.compareAtPriceV2;
    const price = pv2?.amount != null
        ? String(pv2.amount)
        : variant.price != null
            ? String(variant.price)
            : null;
    const compareAtPrice = cv2?.amount != null
        ? String(cv2.amount)
        : variant.compareAtPrice != null
            ? String(variant.compareAtPrice)
            : null;
    return { price, compareAtPrice };
}
let ShopifyProductSyncService = ShopifyProductSyncService_1 = class ShopifyProductSyncService {
    constructor(prisma, shopifyClient) {
        this.prisma = prisma;
        this.shopifyClient = shopifyClient;
        this.logger = new common_1.Logger(ShopifyProductSyncService_1.name);
    }
    async syncProducts(tenantId, agentId) {
        const { domain, token } = await this.shopifyClient.getAgentShopifyConfig(tenantId, agentId);
        const productListQuery = `
      query ProductSyncPage($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            handle
            vendor
            productType
            status
            description
            descriptionHtml
            tags
            metafields(first: 25) {
              nodes {
                namespace
                key
                value
              }
            }
          }
        }
      }
    `;
        const variantPageQuery = `
      query ProductVariantsPage($id: ID!, $first: Int!, $after: String) {
        product(id: $id) {
          id
          variants(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              sku
              price
              compareAtPrice
              priceV2 {
                amount
              }
              compareAtPriceV2 {
                amount
              }
              inventoryQuantity
              availableForSale
              metafields(first: 25) {
                nodes {
                  namespace
                  key
                  value
                }
              }
            }
          }
        }
      }
    `;
        let syncedProducts = 0;
        let syncedVariants = 0;
        let hasNextPage = true;
        let cursor = null;
        let productPageCount = 0;
        const seenProductCursors = new Set();
        while (hasNextPage) {
            if (productPageCount >= MAX_PRODUCT_SYNC_PAGES) {
                throw new Error(`Shopify product sync aborted: exceeded ${MAX_PRODUCT_SYNC_PAGES} pages.`);
            }
            let data;
            try {
                data = await this.shopifyClient.adminGraphql(domain, token, productListQuery, {
                    first: PRODUCTS_PAGE_SIZE,
                    after: cursor,
                });
            }
            catch (err) {
                this.logSyncFailure('product_page', tenantId, agentId, domain, err);
                throw err;
            }
            for (const product of data.products.nodes) {
                const productId = String(product.id ?? '');
                if (!productId)
                    continue;
                if (SYNC_THROTTLE_MS)
                    await sleep(SYNC_THROTTLE_MS);
                const variants = await this.fetchAllVariantNodes(domain, token, variantPageQuery, productId);
                try {
                    const cached = await this.prisma.productCache.upsert({
                        where: {
                            tenantId_agentId_shopifyProductId: { tenantId, agentId, shopifyProductId: productId },
                        },
                        create: {
                            tenantId,
                            agentId,
                            shopDomain: domain,
                            shopifyProductId: productId,
                            handle: String(product.handle ?? ''),
                            title: String(product.title ?? 'Untitled'),
                            vendor: String(product.vendor ?? ''),
                            productType: String(product.productType ?? ''),
                            status: String(product.status ?? ''),
                            bodyHtml: product.descriptionHtml != null
                                ? String(product.descriptionHtml)
                                : product.description != null
                                    ? String(product.description)
                                    : null,
                            tags: Array.isArray(product.tags)
                                ? product.tags.join(',')
                                : String(product.tags ?? ''),
                            rawJson: { ...product, variants: { nodes: variants } },
                        },
                        update: {
                            shopDomain: domain,
                            handle: String(product.handle ?? ''),
                            title: String(product.title ?? 'Untitled'),
                            vendor: String(product.vendor ?? ''),
                            productType: String(product.productType ?? ''),
                            status: String(product.status ?? ''),
                            bodyHtml: product.descriptionHtml != null
                                ? String(product.descriptionHtml)
                                : product.description != null
                                    ? String(product.description)
                                    : null,
                            tags: Array.isArray(product.tags)
                                ? product.tags.join(',')
                                : String(product.tags ?? ''),
                            rawJson: { ...product, variants: { nodes: variants } },
                            syncedAt: new Date(),
                        },
                    });
                    syncedProducts += 1;
                    for (const variant of variants) {
                        const variantId = String(variant.id ?? '');
                        if (!variantId)
                            continue;
                        const { price, compareAtPrice } = variantPriceStrings(variant);
                        await this.prisma.variantCache.upsert({
                            where: { tenantId_shopifyVariantId: { tenantId, shopifyVariantId: variantId } },
                            create: {
                                tenantId,
                                productCacheId: cached.id,
                                shopifyVariantId: variantId,
                                title: String(variant.title ?? ''),
                                sku: variant.sku != null ? String(variant.sku) : null,
                                price: price ?? undefined,
                                compareAtPrice: compareAtPrice ?? undefined,
                                inventoryQuantity: Number(variant.inventoryQuantity ?? 0),
                                availableForSale: Boolean(variant.availableForSale),
                                rawJson: variant,
                            },
                            update: {
                                productCacheId: cached.id,
                                title: String(variant.title ?? ''),
                                sku: variant.sku != null ? String(variant.sku) : null,
                                price: price ?? undefined,
                                compareAtPrice: compareAtPrice ?? undefined,
                                inventoryQuantity: Number(variant.inventoryQuantity ?? 0),
                                availableForSale: Boolean(variant.availableForSale),
                                rawJson: variant,
                                syncedAt: new Date(),
                            },
                        });
                        syncedVariants += 1;
                    }
                    const syncedVariantIds = variants
                        .map((variant) => String(variant.id ?? '').trim())
                        .filter((id) => id.length > 0);
                    await this.prisma.variantCache.deleteMany({
                        where: {
                            tenantId,
                            productCacheId: cached.id,
                            ...(syncedVariantIds.length > 0
                                ? { shopifyVariantId: { notIn: syncedVariantIds } }
                                : {}),
                        },
                    });
                }
                catch (err) {
                    this.logger.error(JSON.stringify({
                        event: 'shopify.sync.product_upsert_failed',
                        tenantId,
                        agentId,
                        shopDomain: domain,
                        productId,
                        message: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
                    }));
                    throw err;
                }
            }
            hasNextPage = data.products.pageInfo.hasNextPage;
            cursor = data.products.pageInfo.endCursor;
            productPageCount += 1;
            if (cursor) {
                if (seenProductCursors.has(cursor)) {
                    throw new Error('Shopify product sync aborted: repeated product pagination cursor detected.');
                }
                seenProductCursors.add(cursor);
            }
        }
        this.logger.log(JSON.stringify({
            event: 'shopify.sync.completed',
            tenantId,
            agentId,
            shopDomain: domain,
            syncedProducts,
            syncedVariants,
        }));
        return { syncedProducts, syncedVariants, shopDomain: domain };
    }
    async fetchAllVariantNodes(domain, token, query, productGid) {
        const out = [];
        let vCursor = null;
        let vHasNext = true;
        let variantPageCount = 0;
        const seenVariantCursors = new Set();
        while (vHasNext) {
            if (variantPageCount >= MAX_VARIANT_SYNC_PAGES) {
                throw new Error(`Shopify variant sync aborted: exceeded ${MAX_VARIANT_SYNC_PAGES} pages for product ${productGid}.`);
            }
            let data;
            try {
                data = await this.shopifyClient.adminGraphql(domain, token, query, {
                    id: productGid,
                    first: VARIANTS_PAGE_SIZE,
                    after: vCursor,
                });
            }
            catch (err) {
                this.logSyncFailure('variant_page', undefined, undefined, domain, err, productGid);
                throw err;
            }
            const productNode = data.product;
            if (!productNode) {
                this.logger.warn(JSON.stringify({
                    event: 'shopify.sync.product_missing_mid_sync',
                    shopDomain: domain,
                    productGid,
                }));
                break;
            }
            const conn = productNode.variants;
            out.push(...conn.nodes);
            vHasNext = conn.pageInfo.hasNextPage;
            vCursor = conn.pageInfo.endCursor;
            variantPageCount += 1;
            if (vCursor) {
                if (seenVariantCursors.has(vCursor)) {
                    throw new Error(`Shopify variant sync aborted: repeated variant pagination cursor for product ${productGid}.`);
                }
                seenVariantCursors.add(vCursor);
            }
            if (SYNC_THROTTLE_MS && vHasNext)
                await sleep(SYNC_THROTTLE_MS);
        }
        return out;
    }
    logSyncFailure(phase, tenantId, agentId, domain, err, productGid) {
        const base = {
            event: 'shopify.sync.failed',
            phase,
            tenantId: tenantId ?? null,
            agentId: agentId ?? null,
            shopDomain: domain,
            productGid: productGid ?? null,
        };
        if (err instanceof shopify_errors_1.ShopifyGraphqlError) {
            this.logger.error(JSON.stringify({
                ...base,
                retryable: err.retryable,
                status: err.status,
                graphql: err.summary().slice(0, 500),
            }));
        }
        else {
            this.logger.error(JSON.stringify({
                ...base,
                message: err instanceof Error ? err.message.slice(0, 400) : 'unknown_error',
            }));
        }
    }
};
exports.ShopifyProductSyncService = ShopifyProductSyncService;
exports.ShopifyProductSyncService = ShopifyProductSyncService = ShopifyProductSyncService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        client_1.ShopifyClientService])
], ShopifyProductSyncService);
//# sourceMappingURL=product-sync.js.map