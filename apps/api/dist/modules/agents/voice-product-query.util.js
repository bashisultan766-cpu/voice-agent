"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanVoiceProductQuery = cleanVoiceProductQuery;
exports.extractBookTitlesFromUtterance = extractBookTitlesFromUtterance;
exports.pickVoiceProductSearchQuery = pickVoiceProductSearchQuery;
exports.slugifyProductHandleHint = slugifyProductHandleHint;
exports.buildShopifyProductSearchAttempts = buildShopifyProductSearchAttempts;
const FILLER_PHRASES = /\b(i\s+need|i\s+want|i'?m\s+looking\s+for|looking\s+for|show\s+me|can\s+you\s+get|give\s+me|do\s+you\s+have\s+it|do\s+you\s+have|could\s+you\s+check|is\s+it\s+available|got\s+any|uh|um|er|ah|like|please|thanks|thank\s+you)\b/gi;
const BOOK_WORD = /\bbooks?\b/gi;
const TRAILING_TAIL = /\b(it|that|this|one|them|those|something|anything)\s*[.?!,]*\s*$/i;
function extractIsbnDigitsFromText(s) {
    const digits = s.replace(/[^0-9Xx]/g, '');
    if (digits.length === 10 || digits.length === 13)
        return digits.toUpperCase();
    return null;
}
function cleanVoiceProductQuery(raw) {
    let s = `${raw ?? ''}`.trim();
    if (!s)
        return { cleanedQuery: '', probableTitle: '' };
    s = s.replace(FILLER_PHRASES, ' ');
    s = s.replace(BOOK_WORD, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    const theBook = s.match(/\bthe\s+book\s+(.+)/i);
    if (theBook?.[1]) {
        s = theBook[1].trim();
    }
    s = s.replace(TRAILING_TAIL, '').trim();
    s = s.replace(/[.?!,;:]+$/g, '').trim();
    const quoted = s.match(/["“”']([^"“”']{2,200})["“”']/);
    const probableTitle = (quoted?.[1]?.trim() || s).trim();
    return {
        cleanedQuery: s.trim(),
        probableTitle: probableTitle.trim(),
    };
}
const TITLE_CONNECTOR = /\s+(?:and|&|plus)\s+/i;
function extractBookTitlesFromUtterance(raw) {
    const text = `${raw ?? ''}`.trim();
    if (!text)
        return [];
    const quoted = [...text.matchAll(/["“”']([^"“”']{2,120})["“”']/g)]
        .map((m) => m[1]?.trim())
        .filter((q) => Boolean(q && q.length >= 2));
    if (quoted.length >= 2)
        return [...new Set(quoted)];
    const { cleanedQuery, probableTitle } = cleanVoiceProductQuery(text);
    const base = probableTitle || cleanedQuery;
    if (!base)
        return [];
    const parts = base
        .split(TITLE_CONNECTOR)
        .map((p) => p.trim())
        .filter((p) => p.length >= 3);
    if (parts.length >= 2)
        return [...new Set(parts)];
    return [base];
}
function pickVoiceProductSearchQuery(toolQuery, metadata) {
    const q = `${toolQuery ?? ''}`.trim();
    const raw = typeof metadata?.lastRawTranscript === 'string' ? metadata.lastRawTranscript.trim() : '';
    const normalized = typeof metadata?.lastNormalizedTranscript === 'string'
        ? metadata.lastNormalizedTranscript.trim()
        : '';
    if (!normalized)
        return q;
    if (!q)
        return normalized;
    if (raw && (q === raw || q.toLowerCase() === raw.toLowerCase()))
        return normalized;
    if (raw && raw.toLowerCase().includes(q.toLowerCase()) && q.length < raw.length * 0.9) {
        return normalized;
    }
    return q;
}
function slugifyProductHandleHint(title) {
    return title
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
function buildShopifyProductSearchAttempts(input) {
    const pt = input.probableTitle.trim();
    const cq = input.cleanedQuery.trim();
    const raw = input.productSearchInputRaw.trim();
    const attempts = [];
    const seen = new Set();
    const push = (label, query) => {
        const q = query.trim();
        const k = `${label}\0${q}`;
        if (!q || seen.has(k))
            return;
        seen.add(k);
        attempts.push({ label, query: q });
    };
    if (pt.length >= 2) {
        const safe = pt.replace(/"/g, '');
        push('1_title_quoted', `title:"${safe}"`);
        push('2_phrase_quoted', `"${safe}"`);
        push('3_title_fuzzy', safe);
        const handle = slugifyProductHandleHint(pt);
        if (handle.length >= 3)
            push('4_handle', `handle:${handle}`);
        push('5a_sku_title', `sku:${safe}`);
        if (safe.includes(' '))
            push('5b_sku_title_quoted', `sku:"${safe}"`);
        const skuCompact = safe.replace(/\s+/g, '');
        if (skuCompact.length >= 3 && skuCompact !== safe.toLowerCase().replace(/\s/g, '')) {
            push('5c_sku_compact', `sku:${skuCompact}`);
        }
    }
    if (cq.length >= 2 && cq.toLowerCase() !== pt.toLowerCase()) {
        push('cleaned_query_fuzzy', cq);
    }
    const isbnFromRaw = extractIsbnDigitsFromText(raw);
    const isbnFromCleaned = extractIsbnDigitsFromText(cq);
    const digits = isbnFromRaw ?? isbnFromCleaned;
    if (digits) {
        push('6a_sku_isbn', `sku:${digits}`);
        push('6b_barcode_isbn', `barcode:${digits}`);
        push('6c_bare_isbn', digits);
    }
    const words = pt
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^a-z0-9]/g, ''))
        .filter((w) => w.length >= 3);
    for (const w of words.slice(0, 4)) {
        push(`7_tag_${w}`, `tag:${w}`);
        push(`8a_vendor_${w}`, `vendor:${w}`);
        push(`8b_product_type_${w}`, `product_type:${w}`);
    }
    return attempts;
}
//# sourceMappingURL=voice-product-query.util.js.map