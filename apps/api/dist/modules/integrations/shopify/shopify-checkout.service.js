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
var ShopifyCheckoutService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyCheckoutService = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const cart_checkout_1 = require("./cart-checkout");
const draft_order_1 = require("./draft-order");
const client_1 = require("./client");
const product_sync_1 = require("./product-sync");
const product_sync_queue_1 = require("./product-sync.queue");
const shopify_ids_1 = require("./shopify-ids");
const shopify_errors_1 = require("./shopify-errors");
const shopify_checkout_cache_strategy_util_1 = require("./shopify-checkout-cache-strategy.util");
function normalizeLookupKey(value) {
    return value.trim().toLowerCase();
}
let ShopifyCheckoutService = ShopifyCheckoutService_1 = class ShopifyCheckoutService {
    constructor(prisma, shopifyClient, cartCheckout, draftOrderCheckout, productSync, syncQueue) {
        this.prisma = prisma;
        this.shopifyClient = shopifyClient;
        this.cartCheckout = cartCheckout;
        this.draftOrderCheckout = draftOrderCheckout;
        this.productSync = productSync;
        this.syncQueue = syncQueue;
        this.logger = new common_1.Logger(ShopifyCheckoutService_1.name);
    }
    async createCheckoutLink(tenantId, agentId, input) {
        const customerEmail = input.customer?.email?.trim();
        if (!customerEmail) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('EMAIL_REQUIRED', 'Customer email is required before creating checkout.');
        }
        const { domain, shopifyConnectionId } = await this.shopifyClient.getAgentShopifyConfig(tenantId, agentId);
        const rawRows = (input.items ?? [])
            .map((i) => ({
            variantKey: (i.variantId || i.productId || '').trim(),
            sku: (i.sku || '').trim(),
            title: (i.title || '').trim(),
            quantity: Math.max(1, Number(i.quantity) || 1),
        }))
            .filter((i) => i.variantKey.length > 0 || i.sku.length > 0 || i.title.length > 0);
        if (rawRows.length === 0) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('NO_LINE_ITEMS', 'Cannot create checkout without at least one catalog variant or product id.');
        }
        const lines = [];
        let repairedFromLive = false;
        for (const row of rawRows) {
            const { line, repaired } = await this.resolveLineItem(tenantId, agentId, domain, row.variantKey || row.sku || row.title, row.quantity);
            if (repaired)
                repairedFromLive = true;
            lines.push(line);
        }
        if (repairedFromLive) {
            this.logger.log(JSON.stringify({
                event: 'voice.shopify.checkout_retry_success',
                tenantId,
                agentId,
                shopDomain: domain,
                lineCount: lines.length,
                cacheStrategy: (0, shopify_checkout_cache_strategy_util_1.getShopifyCheckoutCacheStrategy)(),
            }));
        }
        const aggregated = new Map();
        for (const line of lines) {
            const key = line.variantGid;
            const current = aggregated.get(key);
            if (!current) {
                aggregated.set(key, { ...line });
            }
            else {
                current.quantity += line.quantity;
            }
        }
        const dedupedLines = [...aggregated.values()];
        const configuredMode = await this.prisma.agentConfig.findUnique({
            where: { agentId },
            select: { checkoutMode: true },
        });
        const mode = input.mode ?? configuredMode?.checkoutMode ?? 'STOREFRONT_CART';
        const fingerprint = this.buildFingerprint(mode, customerEmail, dedupedLines.map((l) => ({ variantGid: l.variantGid, quantity: l.quantity })));
        const existing = await this.findReusableCheckoutLink(tenantId, agentId, input.callSessionId, fingerprint, input.forceNewCheckout === true);
        if (existing) {
            const itemCount = Array.isArray(existing.itemsJson)
                ? existing.itemsJson.length
                : dedupedLines.length;
            return {
                checkoutUrl: existing.checkoutUrl,
                itemCount,
                checkoutLinkId: existing.id,
                mode: existing.mode,
                reusedExisting: true,
            };
        }
        const metadata = {
            shopDomain: domain,
            shopifyConnectionId,
            flow: mode === 'DRAFT_ORDER_INVOICE' ? 'draft_order_invoice' : 'storefront_cart_permalink',
            customer: (input.customer ?? {}),
            deliveryAddress: (input.deliveryAddress ?? {}),
            resolvedAt: new Date().toISOString(),
            lineCount: lines.length,
            checkoutFingerprint: fingerprint,
            cacheStrategy: (0, shopify_checkout_cache_strategy_util_1.getShopifyCheckoutCacheStrategy)(),
            lineItems: dedupedLines.map((line) => ({
                variantGid: line.variantGid,
                storefrontVariantId: line.storefrontVariantId,
                quantity: line.quantity,
                title: line.title,
                sku: line.sku,
            })),
        };
        if (mode === 'DRAFT_ORDER_INVOICE') {
            const link = await this.draftOrderCheckout.createDraftOrderCheckout(tenantId, agentId, {
                callSessionId: input.callSessionId,
                email: customerEmail,
                lines: dedupedLines,
                note: input.note,
                checkoutFingerprint: fingerprint,
                metadata,
            });
            return {
                checkoutUrl: link.checkoutUrl,
                itemCount: dedupedLines.length,
                checkoutLinkId: link.id,
                mode: 'DRAFT_ORDER_INVOICE',
            };
        }
        const link = await this.cartCheckout.createStorefrontCartCheckout(tenantId, agentId, {
            callSessionId: input.callSessionId,
            email: customerEmail,
            lines: dedupedLines,
            checkoutFingerprint: fingerprint,
            metadata,
        });
        return {
            checkoutUrl: link.checkoutUrl,
            itemCount: dedupedLines.length,
            checkoutLinkId: link.id,
            mode: 'STOREFRONT_CART',
        };
    }
    buildFingerprint(mode, email, lines) {
        const canonical = lines
            .map((l) => `${l.variantGid}:${l.quantity}`)
            .sort()
            .join('|');
        return (0, node_crypto_1.createHash)('sha256')
            .update(`${mode}|${email.trim().toLowerCase()}|${canonical}`)
            .digest('hex');
    }
    async findReusableCheckoutLink(tenantId, agentId, callSessionId, fingerprint, forceNew) {
        if (forceNew || !callSessionId)
            return null;
        return this.prisma.checkoutLink.findFirst({
            where: {
                tenantId,
                agentId,
                callSessionId,
                checkoutFingerprint: fingerprint,
                status: { in: ['CREATED', 'SENT', 'OPENED'] },
            },
            orderBy: { createdAt: 'desc' },
        });
    }
    async resolveLineItem(tenantId, agentId, shopDomain, rawKey, quantity) {
        const strategy = (0, shopify_checkout_cache_strategy_util_1.getShopifyCheckoutCacheStrategy)();
        const staleMs = (0, shopify_checkout_cache_strategy_util_1.getCheckoutCatalogStaleMs)();
        let repaired = false;
        let v = null;
        if ((0, shopify_checkout_cache_strategy_util_1.shouldReadVariantCache)(strategy)) {
            v = await this.lookupVariantInCache(tenantId, agentId, shopDomain, rawKey);
            if (v && (0, shopify_checkout_cache_strategy_util_1.shouldFetchLiveVariantOnMiss)(strategy) && (0, shopify_checkout_cache_strategy_util_1.isVariantCacheRowStale)(v.syncedAt, staleMs)) {
                this.logger.log(JSON.stringify({
                    event: 'voice.shopify.variant_cache_stale',
                    tenantId,
                    agentId,
                    shopDomain,
                    variantId: v.shopifyVariantId,
                    syncedAt: v.syncedAt?.toISOString() ?? null,
                    staleMs,
                }));
                const refreshed = await this.repairVariantCache(tenantId, agentId, shopDomain, rawKey);
                if (refreshed) {
                    repaired = true;
                    v = refreshed;
                }
            }
        }
        if (!v && (0, shopify_checkout_cache_strategy_util_1.shouldFetchLiveVariantOnMiss)(strategy)) {
            this.logger.log(JSON.stringify({
                event: 'voice.shopify.variant_cache_miss',
                tenantId,
                agentId,
                shopDomain,
                rawKey: rawKey.slice(0, 80),
                cacheStrategy: strategy,
            }));
            this.logger.log(JSON.stringify({
                event: 'voice.shopify.variant_live_lookup',
                tenantId,
                agentId,
                shopDomain,
                rawKey: rawKey.slice(0, 80),
            }));
            void this.enqueueCatalogHeal(tenantId, agentId);
            const repairedRow = await this.repairVariantCache(tenantId, agentId, shopDomain, rawKey);
            if (repairedRow) {
                repaired = true;
                v = repairedRow;
                this.logger.log(JSON.stringify({
                    event: 'voice.shopify.variant_cache_repaired',
                    tenantId,
                    agentId,
                    shopDomain,
                    variantId: repairedRow.shopifyVariantId,
                }));
            }
        }
        if (!v) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('VARIANT_NOT_IN_CACHE', `Variant not resolvable for checkout (cache strategy=${strategy}). Ref: ${rawKey.slice(0, 64)}`);
        }
        if (!v.availableForSale || (v.inventoryQuantity ?? 0) <= 0) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('VARIANT_UNAVAILABLE', `The selected variant is currently unavailable for sale. Please choose another option.`);
        }
        return { line: this.toResolvedLine(v, quantity), repaired };
    }
    async repairVariantCache(tenantId, agentId, shopDomain, rawKey) {
        try {
            return await this.productSync.repairVariantCacheFromShopify(tenantId, agentId, shopDomain, rawKey);
        }
        catch (err) {
            this.logger.warn(JSON.stringify({
                event: 'voice.shopify.variant_cache_repair_failed',
                tenantId,
                agentId,
                shopDomain,
                rawKey: rawKey.slice(0, 80),
                message: err instanceof Error ? err.message.slice(0, 240) : 'error',
            }));
            return null;
        }
    }
    async enqueueCatalogHeal(tenantId, agentId) {
        try {
            await this.syncQueue.enqueue(tenantId, agentId);
        }
        catch (err) {
            this.logger.warn(JSON.stringify({
                event: 'voice.shopify.catalog_heal_queue_skipped',
                tenantId,
                agentId,
                message: err instanceof Error ? err.message.slice(0, 200) : 'queue_unavailable',
            }));
        }
    }
    async lookupVariantInCache(tenantId, agentId, shopDomain, rawKey) {
        const productScope = { shopDomain, agentId };
        const variantKeys = (0, shopify_ids_1.variantIdLookupKeys)(rawKey);
        let v = await this.prisma.variantCache.findFirst({
            where: {
                tenantId,
                shopifyVariantId: { in: variantKeys },
                product: productScope,
            },
            include: { product: { select: { title: true, shopifyProductId: true } } },
        });
        if (!v) {
            const skuKey = normalizeLookupKey(rawKey);
            if (skuKey.length > 0) {
                v = await this.prisma.variantCache.findFirst({
                    where: {
                        tenantId,
                        sku: { equals: skuKey, mode: 'insensitive' },
                        product: productScope,
                    },
                    include: { product: { select: { title: true, shopifyProductId: true } } },
                    orderBy: { updatedAt: 'desc' },
                });
            }
        }
        if (!v) {
            const titleKey = rawKey.trim();
            if (titleKey.length > 0) {
                v = await this.prisma.variantCache.findFirst({
                    where: {
                        tenantId,
                        title: { contains: titleKey, mode: 'insensitive' },
                        product: productScope,
                    },
                    include: { product: { select: { title: true, shopifyProductId: true } } },
                    orderBy: { updatedAt: 'desc' },
                });
            }
        }
        if (!v) {
            const productKeys = (0, shopify_ids_1.productIdLookupKeys)(rawKey);
            v = await this.prisma.variantCache.findFirst({
                where: {
                    tenantId,
                    product: {
                        ...productScope,
                        shopifyProductId: { in: productKeys },
                    },
                },
                orderBy: { updatedAt: 'desc' },
                include: { product: { select: { title: true, shopifyProductId: true } } },
            });
        }
        return v;
    }
    toResolvedLine(v, quantity) {
        const variantGid = (0, shopify_ids_1.toProductVariantGid)(v.shopifyVariantId);
        const storefrontVariantId = (0, shopify_ids_1.toStorefrontCartVariantId)(v.shopifyVariantId);
        const pTitle = v.product?.title;
        const vTitle = v.title;
        const title = pTitle && vTitle && vTitle !== 'Default Title'
            ? `${pTitle} — ${vTitle}`
            : pTitle || vTitle || undefined;
        return {
            variantGid,
            storefrontVariantId,
            quantity: Math.max(1, quantity),
            title,
            sku: v.sku,
        };
    }
};
exports.ShopifyCheckoutService = ShopifyCheckoutService;
exports.ShopifyCheckoutService = ShopifyCheckoutService = ShopifyCheckoutService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        client_1.ShopifyClientService,
        cart_checkout_1.ShopifyCartCheckoutService,
        draft_order_1.ShopifyDraftOrderService,
        product_sync_1.ShopifyProductSyncService,
        product_sync_queue_1.ShopifyProductSyncQueueService])
], ShopifyCheckoutService);
//# sourceMappingURL=shopify-checkout.service.js.map