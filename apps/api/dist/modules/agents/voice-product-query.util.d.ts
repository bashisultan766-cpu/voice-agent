export declare function cleanVoiceProductQuery(raw: string): {
    cleanedQuery: string;
    probableTitle: string;
};
export declare function extractBookTitlesFromUtterance(raw: string): string[];
export declare function pickVoiceProductSearchQuery(toolQuery: string, metadata: Record<string, unknown> | null | undefined): string;
export declare function slugifyProductHandleHint(title: string): string;
export interface ShopifySearchAttempt {
    label: string;
    query: string;
}
export declare function buildShopifyProductSearchAttempts(input: {
    probableTitle: string;
    cleanedQuery: string;
    productSearchInputRaw: string;
}): ShopifySearchAttempt[];
