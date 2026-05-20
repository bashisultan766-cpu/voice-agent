"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyCheckoutValidationError = exports.ShopifyRestError = exports.ShopifyGraphqlError = void 0;
exports.isShopifyRetryableError = isShopifyRetryableError;
exports.formatShopifyErrorForCaller = formatShopifyErrorForCaller;
function isRetryableHttpStatus(status) {
    return status === 429 || status === 408 || status === 409 || (status >= 500 && status <= 599);
}
class ShopifyGraphqlError extends Error {
    constructor(message, errors, status) {
        super(message);
        this.name = 'ShopifyGraphqlError';
        const normalizedErrors = Array.isArray(errors) ? errors : [{ message: String(message || 'Shopify GraphQL error') }];
        this.errors = normalizedErrors;
        this.status = status;
        this.retryable =
            isRetryableHttpStatus(status) ||
                normalizedErrors.some((e) => {
                    const code = e.extensions?.code?.toUpperCase();
                    return code === 'THROTTLED' || code === 'INTERNAL_SERVER_ERROR';
                });
    }
    summary() {
        return this.errors.map((e) => e.message).join('; ') || this.message;
    }
}
exports.ShopifyGraphqlError = ShopifyGraphqlError;
class ShopifyRestError extends Error {
    constructor(message, status, bodySnippet) {
        super(message);
        this.name = 'ShopifyRestError';
        this.status = status;
        this.bodySnippet = bodySnippet;
        this.retryable = isRetryableHttpStatus(status);
    }
}
exports.ShopifyRestError = ShopifyRestError;
class ShopifyCheckoutValidationError extends Error {
    constructor(code, message) {
        super(message);
        this.retryable = false;
        this.name = 'ShopifyCheckoutValidationError';
        this.code = code;
    }
}
exports.ShopifyCheckoutValidationError = ShopifyCheckoutValidationError;
function isShopifyRetryableError(err) {
    return err instanceof ShopifyGraphqlError
        ? err.retryable
        : err instanceof ShopifyRestError
            ? err.retryable
            : false;
}
function formatShopifyErrorForCaller(err) {
    if (err instanceof ShopifyCheckoutValidationError)
        return err.message;
    if (err instanceof ShopifyGraphqlError) {
        return err.retryable
            ? 'The store connection hit a temporary limit. Please try again in a moment.'
            : `Shopify could not complete that request: ${err.summary().slice(0, 200)}`;
    }
    if (err instanceof ShopifyRestError) {
        return err.retryable
            ? 'The store had a brief connection issue. Please try again shortly.'
            : `Shopify returned an error (${err.status}).`;
    }
    if (err instanceof Error)
        return err.message.slice(0, 300);
    return 'Shopify request failed.';
}
//# sourceMappingURL=shopify-errors.js.map