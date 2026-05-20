"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTrailingNumericId = extractTrailingNumericId;
exports.toProductVariantGid = toProductVariantGid;
exports.toProductGid = toProductGid;
exports.toStorefrontCartVariantId = toStorefrontCartVariantId;
exports.variantIdLookupKeys = variantIdLookupKeys;
exports.productIdLookupKeys = productIdLookupKeys;
function extractTrailingNumericId(raw) {
    const t = raw.trim();
    const m = t.match(/(\d+)\s*$/);
    if (m)
        return m[1];
    const digits = t.replace(/\D/g, '');
    return digits || '';
}
function toProductVariantGid(raw) {
    const t = raw.trim();
    if (t.startsWith('gid://shopify/ProductVariant/'))
        return t;
    const num = extractTrailingNumericId(t);
    if (!num)
        return t;
    return `gid://shopify/ProductVariant/${num}`;
}
function toProductGid(raw) {
    const t = raw.trim();
    if (t.startsWith('gid://shopify/Product/'))
        return t;
    const num = extractTrailingNumericId(t);
    if (!num)
        return t;
    return `gid://shopify/Product/${num}`;
}
function toStorefrontCartVariantId(raw) {
    const num = extractTrailingNumericId(raw);
    if (!num) {
        throw new Error('Cannot build storefront cart id: variant id has no numeric segment.');
    }
    return num;
}
function variantIdLookupKeys(raw) {
    const t = raw.trim();
    const keys = new Set();
    if (t)
        keys.add(t);
    const num = extractTrailingNumericId(t);
    if (num)
        keys.add(num).add(`gid://shopify/ProductVariant/${num}`);
    return [...keys];
}
function productIdLookupKeys(raw) {
    const t = raw.trim();
    const keys = new Set();
    if (t)
        keys.add(t);
    const num = extractTrailingNumericId(t);
    if (num)
        keys.add(num).add(`gid://shopify/Product/${num}`);
    return [...keys];
}
//# sourceMappingURL=shopify-ids.js.map