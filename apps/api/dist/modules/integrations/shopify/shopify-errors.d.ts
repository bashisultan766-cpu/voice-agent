export type ShopifyGraphqlErrorItem = {
    message: string;
    extensions?: Record<string, unknown>;
    locations?: unknown;
};
export declare class ShopifyGraphqlError extends Error {
    readonly retryable: boolean;
    readonly status: number;
    readonly errors: ShopifyGraphqlErrorItem[];
    constructor(message: string, errors: ShopifyGraphqlErrorItem[], status: number);
    summary(): string;
}
export declare class ShopifyRestError extends Error {
    readonly retryable: boolean;
    readonly status: number;
    readonly bodySnippet?: string;
    constructor(message: string, status: number, bodySnippet?: string);
}
export declare class ShopifyCheckoutValidationError extends Error {
    readonly code: string;
    readonly retryable = false;
    constructor(code: string, message: string);
}
export declare function isShopifyRetryableError(err: unknown): boolean;
export declare function formatShopifyErrorForCaller(err: unknown): string;
