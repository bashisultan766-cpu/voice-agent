"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRODUCT_RELEVANCE_SCORE_THRESHOLD = exports.PRODUCT_SEARCH_CONFIDENT_MIN_SCORE = exports.PRODUCT_SEARCH_CONFIRM_MIN_SCORE = exports.PRODUCT_SEARCH_MIN_CONSIDER_SCORE = void 0;
exports.normalizeForMatch = normalizeForMatch;
exports.scoreCatalogProduct = scoreCatalogProduct;
exports.rankCatalogProductsForVoice = rankCatalogProductsForVoice;
exports.PRODUCT_SEARCH_MIN_CONSIDER_SCORE = 600;
exports.PRODUCT_SEARCH_CONFIRM_MIN_SCORE = 650;
exports.PRODUCT_SEARCH_CONFIDENT_MIN_SCORE = 800;
exports.PRODUCT_RELEVANCE_SCORE_THRESHOLD = exports.PRODUCT_SEARCH_MIN_CONSIDER_SCORE;
function normalizeForMatch(s) {
    return s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeIsbnDigits(value) {
    return value.replace(/[^0-9Xx]/g, '').toUpperCase();
}
function normalizeSkuBarcode(s) {
    return s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}
function queryWordsFromNormalized(normalized) {
    return normalized
        .split(' ')
        .map((w) => w.trim())
        .filter((w) => w.length > 0 && (w.length >= 2 || /^\d+$/.test(w)));
}
function extractQueryIsbn(userQuery) {
    const digits = userQuery.replace(/[^0-9Xx]/g, '');
    if (digits.length === 10 || digits.length === 13)
        return digits.toUpperCase();
    return null;
}
function tagsBlob(tags) {
    return normalizeForMatch((tags ?? []).join(' '));
}
function scoreCatalogProduct(queryOriginal, probableTitle, product) {
    const queryIsbn = extractQueryIsbn(queryOriginal.trim());
    const titleNorm = normalizeForMatch(product.title);
    const probableNorm = normalizeForMatch(probableTitle.trim());
    const queryNorm = normalizeForMatch(queryOriginal);
    const words = queryWordsFromNormalized(probableNorm.length >= 2 ? probableNorm : queryNorm);
    if (probableNorm.length > 0 && titleNorm === probableNorm)
        return { score: 1000, matchReason: 'title_exact_probable' };
    if (queryNorm.length > 0 && titleNorm === queryNorm)
        return { score: 1000, matchReason: 'title_exact_query' };
    if (queryIsbn) {
        const pIsbn = product.isbn ? normalizeIsbnDigits(product.isbn) : '';
        if (pIsbn && pIsbn === queryIsbn)
            return { score: 900, matchReason: 'isbn_exact_product' };
        for (const v of product.variants) {
            const visbn = v.isbn ? normalizeIsbnDigits(v.isbn) : '';
            if (visbn && visbn === queryIsbn)
                return { score: 900, matchReason: 'isbn_exact_variant' };
            const skuDigits = (v.sku ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
            if (skuDigits && skuDigits === queryIsbn)
                return { score: 900, matchReason: 'sku_isbn_exact' };
            const bcDigits = (v.barcode ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
            if (bcDigits && bcDigits === queryIsbn)
                return { score: 900, matchReason: 'barcode_isbn_exact' };
        }
    }
    const matchSkuOrBarcode = (raw) => {
        const r = (raw ?? '').trim();
        if (!r)
            return false;
        const compact = normalizeSkuBarcode(r);
        const qCompact = normalizeSkuBarcode(probableNorm.length >= 2 ? probableTitle : queryOriginal);
        if (!compact)
            return false;
        if (compact === qCompact)
            return true;
        if (probableNorm && compact === normalizeSkuBarcode(probableNorm))
            return true;
        if (queryNorm && compact === normalizeSkuBarcode(queryNorm))
            return true;
        return false;
    };
    for (const v of product.variants) {
        if (matchSkuOrBarcode(v.sku))
            return { score: 900, matchReason: 'sku_exact' };
        if (matchSkuOrBarcode(v.barcode))
            return { score: 900, matchReason: 'barcode_exact' };
    }
    if (words.length > 0) {
        const allInTitle = words.every((w) => titleNorm.includes(w));
        if (allInTitle) {
            return { score: exports.PRODUCT_SEARCH_CONFIDENT_MIN_SCORE, matchReason: 'all_title_words_in_product_title' };
        }
        const phrase = probableNorm.length >= 3 ? probableNorm : '';
        if (phrase && titleNorm.includes(phrase)) {
            return { score: 750, matchReason: 'probable_title_phrase_in_title' };
        }
        const matched = words.filter((w) => titleNorm.includes(w)).length;
        if (matched > 0) {
            const partial = Math.round((matched / words.length) * 580);
            return { score: Math.min(599, Math.max(1, partial)), matchReason: 'partial_title_word_match' };
        }
    }
    const tagsN = tagsBlob(product.tags);
    if (words.length > 0 && tagsN) {
        const matchedTags = words.filter((w) => tagsN.includes(w)).length;
        if (matchedTags === words.length) {
            return { score: 750, matchReason: 'all_words_in_tags' };
        }
        if (matchedTags > 0) {
            const partial = Math.round((matchedTags / words.length) * 580);
            return { score: Math.min(599, Math.max(1, partial)), matchReason: 'partial_tag_word_match' };
        }
    }
    return { score: 0, matchReason: 'no_match' };
}
function rankCatalogProductsForVoice(queryOriginal, probableTitle, products, maxResults) {
    const scored = products.map((p) => {
        const { score, matchReason } = scoreCatalogProduct(queryOriginal, probableTitle, p);
        return { ...p, relevanceScore: score, matchReason };
    });
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore || a.title.localeCompare(b.title));
    const productsAfterRanking = scored.filter((p) => p.relevanceScore >= exports.PRODUCT_SEARCH_MIN_CONSIDER_SCORE).length;
    const rankedForLog = scored
        .filter((p) => p.relevanceScore > 0)
        .slice(0, 15)
        .map((p) => ({ title: p.title, score: p.relevanceScore, matchReason: p.matchReason }));
    const considered = scored.filter((p) => p.relevanceScore >= exports.PRODUCT_SEARCH_MIN_CONSIDER_SCORE);
    const confidentBand = considered.filter((p) => p.relevanceScore >= exports.PRODUCT_SEARCH_CONFIRM_MIN_SCORE);
    const take = Math.max(1, Math.min(3, maxResults));
    const capped = confidentBand.slice(0, take);
    const bestScore = scored[0]?.relevanceScore ?? 0;
    const bestReason = scored[0]?.matchReason ?? null;
    const lowConfidence = bestScore < exports.PRODUCT_SEARCH_CONFIRM_MIN_SCORE;
    const topProduct = scored[0]?.title ?? null;
    return {
        ranked: capped,
        rankedForLog,
        bestScore,
        bestReason: scored.length ? bestReason : null,
        lowConfidence,
        productsAfterRanking,
        topProduct,
    };
}
//# sourceMappingURL=shopify-product-relevance.util.js.map