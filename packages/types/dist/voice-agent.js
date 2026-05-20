"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toCheckoutModeApi = toCheckoutModeApi;
exports.toCheckoutModeForm = toCheckoutModeForm;
exports.checkoutModeDescription = checkoutModeDescription;
exports.normalizeShopifyDomain = normalizeShopifyDomain;
function toCheckoutModeApi(mode) {
    if (!mode)
        return 'STOREFRONT_CART';
    var value = String(mode).trim().toUpperCase();
    return value === 'DRAFT_ORDER_INVOICE' || value === 'DRAFT_ORDER'
        ? 'DRAFT_ORDER_INVOICE'
        : 'STOREFRONT_CART';
}
function toCheckoutModeForm(mode) {
    return toCheckoutModeApi(mode) === 'DRAFT_ORDER_INVOICE' ? 'draft_order' : 'cart';
}
function checkoutModeDescription(mode) {
    if (toCheckoutModeApi(mode) === 'DRAFT_ORDER_INVOICE') {
        return 'Use draft-order invoice checkout (admin draft order + invoice URL) when creating payment links unless the caller needs a standard storefront cart link.';
    }
    return 'Use storefront cart permalink checkout (default cart flow) when creating payment links.';
}
/** Match Shopify client / product sync normalization. */
function normalizeShopifyDomain(rawUrl) {
    if (!(rawUrl === null || rawUrl === void 0 ? void 0 : rawUrl.trim()))
        return null;
    return rawUrl
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/$/, '')
        .toLowerCase();
}
