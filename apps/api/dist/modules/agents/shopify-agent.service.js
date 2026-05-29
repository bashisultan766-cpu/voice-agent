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
var ShopifyAgentService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyAgentService = void 0;
const common_1 = require("@nestjs/common");
const agents_service_1 = require("./agents.service");
const shopify_ids_1 = require("../integrations/shopify/shopify-ids");
const shopify_product_relevance_util_1 = require("./shopify-product-relevance.util");
const voice_product_query_util_1 = require("./voice-product-query.util");
const bookstore_voice_search_service_1 = require("../search/bookstore-voice-search.service");
const voice_commerce_fast_mode_util_1 = require("../calls/runtime/voice-commerce-fast-mode.util");
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_GRAPHQL_VERSION = '2024-10';
const VOICE_PRODUCT_SEARCH_QUERY_FAST = `
  query VoiceProductSearchFast($first: Int!, $query: String!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        handle
        status
        tags
        vendor
        productType
        variants(first: 8) {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              inventoryQuantity
              availableForSale
            }
          }
        }
      }
    }
  }
`;
const VOICE_PRODUCT_SEARCH_QUERY = `
  query VoiceProductSearch($first: Int!, $query: String!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        handle
        status
        tags
        vendor
        productType
        metafields(first: 30) {
          nodes {
            namespace
            key
            value
          }
        }
        variants(first: 25) {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              compareAtPrice
              inventoryQuantity
              availableForSale
              metafields(first: 15) {
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
    }
  }
`;
const VOICE_PRODUCT_BY_ID_QUERY = `
  query VoiceProductById($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      tags
      vendor
      productType
      metafields(first: 30) {
        nodes {
          namespace
          key
          value
        }
      }
      variants(first: 25) {
        edges {
          node {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            availableForSale
            metafields(first: 15) {
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
  }
`;
const VOICE_PRODUCT_VIA_VARIANT_QUERY = `
  query VoiceProductViaVariant($id: ID!) {
    productVariant(id: $id) {
      id
      product {
        id
        title
        handle
        status
        tags
        vendor
        productType
        metafields(first: 30) {
          nodes {
            namespace
            key
            value
          }
        }
        variants(first: 25) {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              compareAtPrice
              inventoryQuantity
              availableForSale
              metafields(first: 15) {
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
    }
  }
`;
const ISBN_KEY_RE = /^isbn(?:[-_]?1[03])?$/i;
function formatVoiceUsd(price) {
    if (price == null || price === '')
        return null;
    const n = Number(price);
    if (!Number.isFinite(n))
        return null;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}
let ShopifyAgentService = ShopifyAgentService_1 = class ShopifyAgentService {
    constructor(agentsService, bookstoreVoiceSearch) {
        this.agentsService = agentsService;
        this.bookstoreVoiceSearch = bookstoreVoiceSearch;
        this.logger = new common_1.Logger(ShopifyAgentService_1.name);
    }
    normalizeAdminDomain(storeUrl) {
        return storeUrl
            .replace(/^https?:\/\//i, '')
            .replace(/\/$/, '')
            .split('/')[0]
            .toLowerCase();
    }
    async adminGraphql(storeUrl, token, query, variables) {
        const domain = this.normalizeAdminDomain(storeUrl);
        const res = await fetch(`https://${domain}/admin/api/${SHOPIFY_GRAPHQL_VERSION}/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': token,
            },
            body: JSON.stringify({ query, variables }),
        });
        const json = (await res.json().catch(() => null));
        if (!res.ok) {
            const msg = json?.errors?.[0]?.message ?? (await res.text()).slice(0, 200);
            throw new Error(`Shopify GraphQL HTTP ${res.status}: ${msg}`);
        }
        if (json?.errors?.length) {
            throw new Error(json.errors.map((e) => e.message ?? 'GraphQL error').join('; '));
        }
        if (json?.data === undefined || json.data === null) {
            throw new Error('Shopify GraphQL returned empty data.');
        }
        if (!ShopifyAgentService_1.shopifyScalarPriceQueryLogged) {
            console.log('SHOPIFY QUERY FIXED - scalar fields used correctly');
            ShopifyAgentService_1.shopifyScalarPriceQueryLogged = true;
        }
        return json.data;
    }
    metafieldList(raw) {
        return (raw?.nodes ?? [])
            .map((n) => ({
            key: typeof n.key === 'string' ? n.key.trim() : '',
            value: typeof n.value === 'string' ? n.value.trim() : '',
        }))
            .filter((n) => n.key && n.value);
    }
    normalizeIsbnCandidate(value) {
        const cleaned = value.replace(/[^0-9Xx]/g, '');
        if (cleaned.length === 10 || cleaned.length === 13)
            return cleaned.toUpperCase();
        return null;
    }
    pickIsbn(sku, barcode, mf) {
        const fromSku = this.normalizeIsbnCandidate(sku ?? '');
        if (fromSku)
            return fromSku;
        const fromBc = this.normalizeIsbnCandidate(barcode ?? '');
        if (fromBc)
            return fromBc;
        for (const m of mf) {
            if (!ISBN_KEY_RE.test(m.key))
                continue;
            const v = this.normalizeIsbnCandidate(m.value);
            if (v)
                return v;
        }
        return null;
    }
    isbnFromTags(tags) {
        for (const t of tags) {
            const v = this.normalizeIsbnCandidate(t);
            if (v)
                return v;
        }
        return null;
    }
    variantNodesFromProduct(node) {
        const edges = node.variants?.edges ?? [];
        return edges.map((e) => e?.node).filter((v) => v != null && Boolean(v.id));
    }
    moneyScalarToString(value) {
        if (value === null || value === undefined || value === '')
            return null;
        return String(value);
    }
    mapGraphqlProductNode(node) {
        if (!node?.id)
            return null;
        const productMf = this.metafieldList(node.metafields);
        const tags = Array.isArray(node.tags) ? node.tags.map((t) => String(t)) : [];
        const variantNodes = this.variantNodesFromProduct(node);
        const variants = variantNodes.map((v) => {
            const vmf = this.metafieldList(v.metafields);
            const isbn = this.pickIsbn(v.sku ?? null, v.barcode ?? null, vmf);
            return {
                id: String(v.id),
                title: typeof v.title === 'string' ? v.title : '',
                inventory_quantity: Number(v.inventoryQuantity ?? 0),
                sku: v.sku ?? null,
                barcode: v.barcode ?? null,
                price: this.moneyScalarToString(v.price),
                isbn,
                availableForSale: v.availableForSale !== false,
            };
        });
        const fallbackIsbn = this.pickIsbn(null, null, productMf);
        const anyVariantIsbn = variants.map((x) => x.isbn).find(Boolean) ?? null;
        const tagIsbn = this.isbnFromTags(tags);
        return {
            id: node.id,
            productId: node.id,
            title: typeof node.title === 'string' ? node.title : 'Untitled',
            handle: node.handle ?? null,
            status: typeof node.status === 'string' ? node.status : 'ACTIVE',
            vendor: node.vendor ?? null,
            productType: node.productType ?? null,
            tags,
            isbn: anyVariantIsbn ?? fallbackIsbn ?? tagIsbn ?? null,
            variants,
        };
    }
    async fetchProductsMergedSearch(storeUrl, token, attempts, limitPerQuery) {
        const cap = Math.min(Math.max(limitPerQuery, 1), 25);
        const byId = new Map();
        const tried = [];
        for (const attempt of attempts) {
            if (!attempt.query.trim())
                continue;
            tried.push(attempt);
            const data = await this.adminGraphql(storeUrl, token, VOICE_PRODUCT_SEARCH_QUERY, { first: cap, query: attempt.query });
            const nodes = data.products?.nodes ?? [];
            for (const n of nodes) {
                const p = this.mapGraphqlProductNode(n);
                if (p && !byId.has(p.productId))
                    byId.set(p.productId, p);
            }
        }
        return { products: [...byId.values()], shopifyQueriesTried: tried };
    }
    async fetchProductsMergedSearchParallel(storeUrl, token, attempts, limitPerQuery) {
        const cap = Math.min(Math.max(limitPerQuery, 1), 25);
        const valid = attempts.filter((a) => a.query.trim());
        const tried = [...valid];
        const queryDoc = (0, voice_commerce_fast_mode_util_1.isVoiceCommerceFastMode)() ? VOICE_PRODUCT_SEARCH_QUERY_FAST : VOICE_PRODUCT_SEARCH_QUERY;
        const batches = await Promise.all(valid.map((attempt) => this.adminGraphql(storeUrl, token, queryDoc, { first: cap, query: attempt.query }).then((data) => ({ attempt, nodes: data.products?.nodes ?? [] }))));
        const byId = new Map();
        for (const { nodes } of batches) {
            for (const n of nodes) {
                const p = this.mapGraphqlProductNode(n);
                if (p && !byId.has(p.productId))
                    byId.set(p.productId, p);
            }
        }
        return { products: [...byId.values()], shopifyQueriesTried: tried };
    }
    async fetchShopify(storeUrl, token, path, params) {
        const base = storeUrl.replace(/\/$/, '');
        const pathWithQuery = params ? `${path}?${new URLSearchParams(params).toString()}` : path;
        const url = path.startsWith('http') ? pathWithQuery : `${base}${path.startsWith('/') ? '' : '/'}${pathWithQuery}`;
        const res = await fetch(url, {
            headers: {
                'X-Shopify-Access-Token': token,
                'Content-Type': 'application/json',
            },
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Shopify API ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }
    async getOrderStatus(tenantId, agentId, orderNumberOrPhone) {
        const config = await this.agentsService.getShopifyConfig(tenantId, agentId);
        if (!config) {
            return { ok: false, error: 'Shopify not connected for this agent.' };
        }
        const trimmed = orderNumberOrPhone.trim().replace(/\D/g, '');
        const isLikelyPhone = trimmed.length >= 10;
        try {
            if (isLikelyPhone) {
                const data = await this.fetchShopify(config.shopifyStoreUrl, config.shopifyAdminToken, `/admin/api/${SHOPIFY_API_VERSION}/orders.json`, {
                    status: 'any',
                    limit: '50',
                });
                const orders = (data.orders ?? []).filter((o) => o.billing_address?.phone && o.billing_address.phone.replace(/\D/g, '').endsWith(trimmed.slice(-10)));
                const list = orders.slice(0, 5).map((o) => ({
                    id: String(o.id),
                    name: o.name,
                    financial_status: o.financial_status,
                    fulfillment_status: o.fulfillment_status,
                    created_at: o.created_at,
                    total_price: o.total_price,
                    note: o.note,
                }));
                const voiceSummary = list.length === 0
                    ? `No orders found for that phone number.`
                    : list.length === 1
                        ? `Order ${list[0].name}: ${list[0].financial_status}, fulfillment ${list[0].fulfillment_status ?? 'pending'}. Total ${list[0].total_price}.`
                        : `Found ${list.length} orders. Latest: ${list[0].name}, ${list[0].financial_status}, ${list[0].fulfillment_status ?? 'pending'}.`;
                return { ok: true, orders: list, voiceSummary };
            }
            else {
                const data = await this.fetchShopify(config.shopifyStoreUrl, config.shopifyAdminToken, `/admin/api/${SHOPIFY_API_VERSION}/orders.json`, {
                    name: orderNumberOrPhone.trim(),
                    status: 'any',
                    limit: '5',
                });
                const orders = data.orders ?? [];
                const list = orders.map((o) => ({
                    id: String(o.id),
                    name: o.name,
                    financial_status: o.financial_status,
                    fulfillment_status: o.fulfillment_status,
                    created_at: o.created_at,
                    total_price: o.total_price,
                    note: o.note,
                }));
                const voiceSummary = list.length === 0
                    ? `No order found with number ${orderNumberOrPhone}.`
                    : `Order ${list[0].name}: ${list[0].financial_status}, fulfillment ${list[0].fulfillment_status ?? 'pending'}. Total ${list[0].total_price}.`;
                return { ok: true, orders: list, voiceSummary };
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Shopify request failed';
            return { ok: false, error: message };
        }
    }
    async searchProducts(tenantId, agentId, query, limit = 5) {
        const config = await this.agentsService.getShopifyConfig(tenantId, agentId);
        if (!config) {
            return { ok: false, error: 'Shopify not connected for this agent.' };
        }
        const productSearchInputRaw = query.trim();
        if (!productSearchInputRaw) {
            const searchVoiceLog = {
                productSearchInputRaw: '',
                cleanedQuery: '',
                probableTitle: '',
                shopifyQueriesTried: [],
                productsReturned: 0,
                productsReturnedCount: 0,
                productsAfterRanking: 0,
                rankedProducts: [],
                topProduct: null,
                topProductTitle: null,
                topScore: null,
                topMatchReason: 'empty_query',
                lowConfidenceSearch: true,
                finalVoiceSummary: `I didn't catch what to search. Could you say the product name again, or spell it?`,
            };
            this.logger.log(JSON.stringify({
                event: 'shopify.voice.product_search_live',
                tenantId,
                agentId,
                productsFound: 0,
                ...searchVoiceLog,
                productSearchInputRaw: searchVoiceLog.productSearchInputRaw,
                probableTitle: searchVoiceLog.probableTitle,
            }));
            return {
                ok: true,
                products: [],
                voiceSummary: searchVoiceLog.finalVoiceSummary,
                searchVoiceLog,
            };
        }
        const titlePhrases = (0, voice_product_query_util_1.extractBookTitlesFromUtterance)(productSearchInputRaw);
        if (titlePhrases.length > 1) {
            const merged = [];
            const seenIds = new Set();
            const summaries = [];
            const perPhrase = Math.max(2, Math.ceil(limit / titlePhrases.length));
            const phraseResults = await Promise.all(titlePhrases.slice(0, 4).map((phrase) => this.searchProducts(tenantId, agentId, phrase, perPhrase)));
            for (const one of phraseResults) {
                if (!one.ok) {
                    return one;
                }
                for (const p of one.products ?? []) {
                    if (!seenIds.has(p.productId)) {
                        seenIds.add(p.productId);
                        merged.push(p);
                    }
                }
                if (one.voiceSummary?.trim())
                    summaries.push(one.voiceSummary.trim());
            }
            return {
                ok: true,
                products: merged.slice(0, limit),
                voiceSummary: summaries.length > 0
                    ? summaries.join(' ')
                    : merged.length > 0
                        ? `I found ${merged.length} titles from your list. Which one would you like?`
                        : `I couldn't find an exact match for those titles. Could you repeat the title or author?`,
                searchVoiceLog: {
                    productSearchInputRaw,
                    cleanedQuery: titlePhrases.join(' | '),
                    probableTitle: titlePhrases[0] ?? '',
                    shopifyQueriesTried: titlePhrases.map((t) => ({ label: 'multi_title', query: t })),
                    productsReturned: merged.length,
                    productsReturnedCount: merged.length,
                    productsAfterRanking: merged.length,
                    rankedProducts: [],
                    topProduct: merged[0]?.title ?? null,
                    topProductTitle: merged[0]?.title ?? null,
                    topScore: merged[0]?.relevanceScore ?? null,
                    topMatchReason: 'multi_title_merge',
                    lowConfidenceSearch: merged.length === 0,
                    finalVoiceSummary: summaries[0] ?? '',
                },
            };
        }
        try {
            this.bookstoreVoiceSearch.warmPopularQueries(tenantId, agentId);
            const shopDomain = this.normalizeAdminDomain(config.shopifyStoreUrl);
            this.bookstoreVoiceSearch.schedulePopularQueryPrefetch(tenantId, agentId, shopDomain, config.shopifyStoreUrl, config.shopifyAdminToken, async (args) => this.fetchProductsMergedSearchParallel(args.storeUrl, args.token, args.attempts, args.limitPerQuery));
            const bookstoreResult = await this.bookstoreVoiceSearch.search({
                tenantId,
                agentId,
                query: productSearchInputRaw,
                limit,
                shopDomain,
                storeUrl: config.shopifyStoreUrl,
                token: config.shopifyAdminToken,
                fetchLive: async ({ storeUrl, token, attempts, limitPerQuery }) => this.fetchProductsMergedSearchParallel(storeUrl, token, attempts, limitPerQuery),
            });
            const searchVoiceLog = bookstoreResult.searchVoiceLog;
            this.logger.log(JSON.stringify({
                event: 'shopify.voice.product_search_live',
                tenantId,
                agentId,
                productsFound: bookstoreResult.products?.length ?? 0,
                ...(searchVoiceLog ?? {}),
                fuzzySearchActivated: searchVoiceLog?.bookstoreSearch?.fuzzySearchActivated,
                semanticSearchUsed: searchVoiceLog?.bookstoreSearch?.semanticSearchUsed,
                semanticSearchActivated: searchVoiceLog?.bookstoreSearch?.semanticSearchActivated,
                semanticConfidence: searchVoiceLog?.bookstoreSearch?.semanticConfidence,
                semanticMatchReason: searchVoiceLog?.bookstoreSearch?.semanticMatchReason,
                fallbackStage: searchVoiceLog?.bookstoreSearch?.fallbackStage,
                cacheHit: searchVoiceLog?.bookstoreSearch?.cacheHit,
                searchLatencyMs: searchVoiceLog?.bookstoreSearch?.searchLatencyMs,
                confidenceTier: searchVoiceLog?.confidenceTier ?? searchVoiceLog?.bookstoreSearch?.confidenceTier,
                recommendedBooks: searchVoiceLog?.bookstoreSearch?.recommendedBooks,
            }));
            return {
                ok: bookstoreResult.ok,
                products: bookstoreResult.products,
                voiceSummary: bookstoreResult.voiceSummary,
                searchVoiceLog: bookstoreResult.searchVoiceLog,
                error: bookstoreResult.error,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Shopify request failed';
            this.logger.warn(JSON.stringify({
                event: 'shopify.voice.product_search_failed',
                tenantId,
                agentId,
                query,
                message: message.slice(0, 300),
            }));
            return { ok: false, error: message };
        }
    }
    async getProductLive(tenantId, agentId, lookup) {
        const config = await this.agentsService.getShopifyConfig(tenantId, agentId);
        if (!config)
            return null;
        const { shopifyStoreUrl: storeUrl, shopifyAdminToken: token } = config;
        try {
            if (lookup.productId?.trim()) {
                const gid = (0, shopify_ids_1.toProductGid)(lookup.productId.trim());
                const data = await this.adminGraphql(storeUrl, token, VOICE_PRODUCT_BY_ID_QUERY, {
                    id: gid,
                });
                return this.mapGraphqlProductNode(data.product);
            }
            if (lookup.variantId?.trim()) {
                const gid = (0, shopify_ids_1.toProductVariantGid)(lookup.variantId.trim());
                const data = await this.adminGraphql(storeUrl, token, VOICE_PRODUCT_VIA_VARIANT_QUERY, { id: gid });
                return this.mapGraphqlProductNode(data.productVariant?.product);
            }
            if (lookup.title?.trim()) {
                const { products } = await this.fetchProductsMergedSearch(storeUrl, token, [{ label: 'title_lookup', query: lookup.title.trim() }], 1);
                return products[0] ?? null;
            }
            return null;
        }
        catch (err) {
            this.logger.warn(JSON.stringify({
                event: 'shopify.voice.product_live_fetch_failed',
                tenantId,
                agentId,
                lookup,
                message: err instanceof Error ? err.message.slice(0, 240) : 'error',
            }));
            return null;
        }
    }
    async debugProductSearch(tenantId, agentId, query) {
        const config = await this.agentsService.getShopifyConfig(tenantId, agentId);
        if (!config) {
            return {
                cleanedQuery: '',
                probableTitle: '',
                shopifyQueriesTried: [],
                productsReturned: 0,
                productsAfterRanking: 0,
                topProduct: null,
                rawShopifyProductTitles: [],
                rankedProducts: [],
                topScore: null,
                topMatchReason: null,
                selectedProduct: null,
                selectionExplanation: 'Shopify not connected for this agent.',
            };
        }
        const rawQ = query.trim();
        const { cleanedQuery, probableTitle } = (0, voice_product_query_util_1.cleanVoiceProductQuery)(rawQ);
        const attempts = (0, voice_product_query_util_1.buildShopifyProductSearchAttempts)({
            probableTitle,
            cleanedQuery,
            productSearchInputRaw: rawQ,
        });
        const { products: rawProducts, shopifyQueriesTried } = await this.fetchProductsMergedSearch(config.shopifyStoreUrl, config.shopifyAdminToken, attempts, 25);
        const rankAgainst = probableTitle || cleanedQuery || rawQ;
        const { ranked, rankedForLog, bestScore, bestReason, productsAfterRanking, topProduct } = (0, shopify_product_relevance_util_1.rankCatalogProductsForVoice)(rawQ, rankAgainst, rawProducts, 3);
        const topRankedScore = ranked[0]?.relevanceScore ?? 0;
        let selected = ranked[0] ?? null;
        let explanation;
        if (!rawProducts.length) {
            explanation = 'No products returned from Shopify for any attempted query.';
            selected = null;
        }
        else if (bestScore < shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIRM_MIN_SCORE) {
            explanation = `Top relevance score ${bestScore} is below confirm threshold ${shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIRM_MIN_SCORE}; the agent will not present a product as a verified match.`;
            selected = null;
        }
        else if (topRankedScore < shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIDENT_MIN_SCORE) {
            explanation = `Score ${topRankedScore} is in the confirmation band (${shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIRM_MIN_SCORE}–${shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIDENT_MIN_SCORE - 1}); the agent should ask the customer to confirm before quoting price or stock.`;
        }
        else if (ranked.length > 1) {
            explanation = `Score ${topRankedScore} is confident, but multiple products met the confirm threshold; the agent should ask which item the customer wants.`;
        }
        else {
            explanation = `Score ${topRankedScore} meets the confident threshold (${shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIDENT_MIN_SCORE}+); the agent may answer with price and stock.`;
        }
        return {
            cleanedQuery,
            probableTitle,
            shopifyQueriesTried: shopifyQueriesTried.map((a) => ({ label: a.label, query: a.query })),
            productsReturned: rawProducts.length,
            productsAfterRanking,
            topProduct,
            rawShopifyProductTitles: rawProducts.map((p) => p.title),
            rankedProducts: rankedForLog,
            topScore: bestScore,
            topMatchReason: bestReason,
            selectedProduct: selected,
            selectionExplanation: explanation,
        };
    }
};
exports.ShopifyAgentService = ShopifyAgentService;
ShopifyAgentService.shopifyScalarPriceQueryLogged = false;
exports.ShopifyAgentService = ShopifyAgentService = ShopifyAgentService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [agents_service_1.AgentsService,
        bookstore_voice_search_service_1.BookstoreVoiceSearchService])
], ShopifyAgentService);
//# sourceMappingURL=shopify-agent.service.js.map