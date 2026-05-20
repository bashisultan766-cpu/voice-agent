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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyProductSearchService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const shopify_ids_1 = require("./shopify-ids");
let ShopifyProductSearchService = class ShopifyProductSearchService {
    constructor(prisma) {
        this.prisma = prisma;
        this.isbnKeyPattern = /^isbn(?:[-_]?1[03])?$/i;
        this.isbnTextPattern = /\b(?:97[89][\s-]?)?\d(?:[\s-]?\d){8,16}\b/g;
    }
    async search(tenantId, query, limit = 8, shopDomain) {
        const q = query.trim();
        if (!q)
            return [];
        const tokens = [...new Set(q.split(/\s+/).filter((t) => t.length > 0))];
        if (tokens.length === 0)
            return [];
        const domain = shopDomain?.trim().toLowerCase() || null;
        const tenantScope = { tenantId };
        if (domain) {
            tenantScope.shopDomain = domain;
        }
        const tokenClauses = tokens.map((token) => ({
            OR: [
                { title: { contains: token, mode: 'insensitive' } },
                { handle: { contains: token, mode: 'insensitive' } },
                { tags: { contains: token, mode: 'insensitive' } },
                { bodyHtml: { contains: token, mode: 'insensitive' } },
                { vendor: { contains: token, mode: 'insensitive' } },
                { productType: { contains: token, mode: 'insensitive' } },
                { variants: { some: { sku: { contains: token, mode: 'insensitive' } } } },
                { variants: { some: { title: { contains: token, mode: 'insensitive' } } } },
            ],
        }));
        const results = await this.prisma.productCache.findMany({
            where: {
                ...tenantScope,
                AND: tokenClauses,
            },
            include: { variants: true },
            take: Math.min(limit, 25),
            orderBy: { updatedAt: 'desc' },
        });
        return results.map((product) => this.mapProduct(product));
    }
    async fuzzySearch(tenantId, query, limit = 8, shopDomain) {
        const normalized = this.normalizeProductQuery(query);
        if (!normalized)
            return { confidence: 0, results: [], normalizedQuery: normalized };
        const tokens = [...new Set(normalized.split(/\s+/).filter(Boolean))];
        const expanded = [...new Set(tokens.flatMap((t) => [t, ...this.synonymsForToken(t)]))];
        const domain = shopDomain?.trim().toLowerCase() || null;
        const tenantScope = { tenantId };
        if (domain)
            tenantScope.shopDomain = domain;
        const tokenClauses = expanded.map((token) => ({
            OR: [
                { title: { contains: token, mode: 'insensitive' } },
                { handle: { contains: token, mode: 'insensitive' } },
                { tags: { contains: token, mode: 'insensitive' } },
                { bodyHtml: { contains: token, mode: 'insensitive' } },
                { vendor: { contains: token, mode: 'insensitive' } },
                { productType: { contains: token, mode: 'insensitive' } },
                { variants: { some: { sku: { contains: token, mode: 'insensitive' } } } },
                { variants: { some: { title: { contains: token, mode: 'insensitive' } } } },
            ],
        }));
        const candidates = await this.prisma.productCache.findMany({
            where: {
                ...tenantScope,
                OR: tokenClauses.length > 0 ? tokenClauses : [{ title: { contains: normalized, mode: 'insensitive' } }],
            },
            include: { variants: true },
            take: 40,
            orderBy: { updatedAt: 'desc' },
        });
        const scored = candidates
            .map((row) => {
            const mapped = this.mapProduct(row);
            const score = this.scoreMatch(normalized, expanded, mapped);
            return { mapped, score };
        })
            .sort((a, b) => b.score - a.score);
        const top = scored.slice(0, Math.min(limit, 25));
        return {
            normalizedQuery: normalized,
            confidence: top[0]?.score ?? 0,
            results: top.map((s) => s.mapped),
        };
    }
    async getDetails(tenantId, lookup, shopDomain) {
        const domain = shopDomain?.trim().toLowerCase() || null;
        const baseWhere = {
            tenantId,
            ...(domain ? { shopDomain: domain } : {}),
        };
        const orConditions = [];
        if (lookup.productId?.trim()) {
            orConditions.push({ shopifyProductId: { in: (0, shopify_ids_1.productIdLookupKeys)(lookup.productId) } });
        }
        if (lookup.title?.trim()) {
            orConditions.push({ title: { contains: lookup.title.trim(), mode: 'insensitive' } });
        }
        if (lookup.variantId?.trim()) {
            const keys = (0, shopify_ids_1.variantIdLookupKeys)(lookup.variantId);
            orConditions.push({ variants: { some: { shopifyVariantId: { in: keys } } } });
        }
        if (orConditions.length === 0)
            return null;
        const product = await this.prisma.productCache.findFirst({
            where: {
                ...baseWhere,
                OR: orConditions,
            },
            include: { variants: true },
        });
        if (!product)
            return null;
        const mapped = this.mapProduct(product);
        const selectedKeys = lookup.variantId?.trim() ? (0, shopify_ids_1.variantIdLookupKeys)(lookup.variantId) : [];
        let selectedVariantId = null;
        if (selectedKeys.length) {
            const match = product.variants.find((v) => selectedKeys.includes(v.shopifyVariantId));
            if (match) {
                selectedVariantId = match.shopifyVariantId;
                mapped.variants = [
                    mapped.variants.find((x) => x.variantId === selectedVariantId),
                    ...mapped.variants.filter((x) => x.variantId !== selectedVariantId),
                ].filter(Boolean);
            }
        }
        return {
            ...mapped,
            selectedVariantId,
        };
    }
    mapProduct(product) {
        const productMetafields = this.readMetafields(product.rawJson);
        const variantIsbnById = new Map();
        for (const variant of product.variants) {
            const isbnFromVariant = this.pickIsbn({
                sku: variant.sku,
                metafields: this.readMetafields(variant.rawJson),
            });
            if (isbnFromVariant) {
                variantIsbnById.set(variant.shopifyVariantId, isbnFromVariant);
            }
        }
        const fallbackProductIsbn = this.pickIsbn({
            metafields: productMetafields,
            tags: product.tags,
            description: product.bodyHtml,
        });
        return {
            productId: product.shopifyProductId,
            title: product.title,
            handle: product.handle,
            vendor: product.vendor,
            productType: product.productType,
            status: product.status,
            tags: product.tags,
            isbn: product.variants
                .map((variant) => variantIsbnById.get(variant.shopifyVariantId) ?? null)
                .find((isbn) => typeof isbn === 'string' && isbn.length > 0) ?? fallbackProductIsbn,
            variants: product.variants.map((variant) => ({
                variantId: variant.shopifyVariantId,
                title: variant.title,
                sku: variant.sku,
                isbn: variantIsbnById.get(variant.shopifyVariantId) ?? fallbackProductIsbn,
                price: variant.price != null ? String(variant.price) : null,
                compareAtPrice: variant.compareAtPrice != null ? String(variant.compareAtPrice) : null,
                inventoryQuantity: variant.inventoryQuantity ?? 0,
                availableForSale: variant.availableForSale ?? false,
            })),
            syncedAt: product.syncedAt,
        };
    }
    normalizeProductQuery(query) {
        return query
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
            .replace(/\b(i want|i need|please|show me|looking for|can you|do you have)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    synonymsForToken(token) {
        const map = {
            sneaker: ['shoe', 'trainer'],
            trainers: ['sneaker', 'shoe'],
            shoe: ['sneaker', 'trainer'],
            tshirt: ['tee', 'shirt'],
            tee: ['tshirt', 'shirt'],
            trousers: ['pants'],
            pants: ['trousers'],
        };
        return map[token] ?? [];
    }
    scoreMatch(normalizedQuery, tokens, product) {
        const title = (product.title ?? '').toLowerCase();
        const variantText = product.variants
            .map((v) => `${v.title ?? ''} ${v.sku ?? ''} ${v.isbn ?? ''}`.trim().toLowerCase())
            .join(' ');
        const haystack = `${title} ${product.handle ?? ''} ${product.tags ?? ''} ${product.vendor ?? ''} ${product.isbn ?? ''} ${variantText}`.toLowerCase();
        let tokenHits = 0;
        for (const token of tokens) {
            if (haystack.includes(token))
                tokenHits += 1;
        }
        const tokenScore = tokens.length > 0 ? tokenHits / tokens.length : 0;
        const editScore = this.similarity(normalizedQuery, title);
        const phoneticScore = this.soundex(normalizedQuery.split(/\s+/)[0] ?? '') === this.soundex(title.split(/\s+/)[0] ?? '') ? 1 : 0;
        return Number((tokenScore * 0.6 + editScore * 0.3 + phoneticScore * 0.1).toFixed(3));
    }
    similarity(a, b) {
        if (!a || !b)
            return 0;
        const dist = this.levenshtein(a, b);
        const maxLen = Math.max(a.length, b.length);
        return maxLen === 0 ? 1 : 1 - dist / maxLen;
    }
    levenshtein(a, b) {
        const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++)
            dp[i][0] = i;
        for (let j = 0; j <= b.length; j++)
            dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
            }
        }
        return dp[a.length][b.length];
    }
    soundex(value) {
        const s = value.toUpperCase().replace(/[^A-Z]/g, '');
        if (!s)
            return '';
        const first = s[0];
        const map = {
            B: '1',
            F: '1',
            P: '1',
            V: '1',
            C: '2',
            G: '2',
            J: '2',
            K: '2',
            Q: '2',
            S: '2',
            X: '2',
            Z: '2',
            D: '3',
            T: '3',
            L: '4',
            M: '5',
            N: '5',
            R: '6',
        };
        const digits = s
            .slice(1)
            .split('')
            .map((c) => map[c] ?? '0')
            .filter((d, idx, arr) => d !== '0' && d !== arr[idx - 1])
            .join('');
        return `${first}${digits}000`.slice(0, 4);
    }
    readMetafields(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return [];
        const node = raw;
        const metafields = node.metafields;
        if (!metafields || typeof metafields !== 'object' || Array.isArray(metafields))
            return [];
        const nodes = metafields.nodes;
        if (!Array.isArray(nodes))
            return [];
        return nodes
            .map((row) => {
            if (!row || typeof row !== 'object' || Array.isArray(row))
                return null;
            const m = row;
            const namespace = typeof m.namespace === 'string' ? m.namespace.trim() : '';
            const key = typeof m.key === 'string' ? m.key.trim() : '';
            const value = typeof m.value === 'string' ? m.value.trim() : '';
            if (!key || !value)
                return null;
            return { namespace, key, value };
        })
            .filter((row) => row !== null);
    }
    pickIsbn(input) {
        const skuIsbn = this.normalizeIsbn(input.sku ?? null);
        if (skuIsbn)
            return skuIsbn;
        for (const field of input.metafields ?? []) {
            if (!this.isbnKeyPattern.test(field.key))
                continue;
            const value = this.normalizeIsbn(field.value);
            if (value)
                return value;
        }
        return this.normalizeIsbn(this.extractIsbnText(input.tags || input.description || null));
    }
    extractIsbnText(text) {
        if (!text)
            return null;
        const matches = text.match(this.isbnTextPattern);
        if (!matches?.length)
            return null;
        return matches[0] ?? null;
    }
    normalizeIsbn(value) {
        if (!value)
            return null;
        const cleaned = value.replace(/[^0-9Xx]/g, '');
        if (cleaned.length === 10 || cleaned.length === 13) {
            return cleaned.toUpperCase();
        }
        return null;
    }
};
exports.ShopifyProductSearchService = ShopifyProductSearchService;
exports.ShopifyProductSearchService = ShopifyProductSearchService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ShopifyProductSearchService);
//# sourceMappingURL=product-search.js.map