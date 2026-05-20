export declare const PRODUCT_SEARCH_MIN_CONSIDER_SCORE = 600;
export declare const PRODUCT_SEARCH_CONFIRM_MIN_SCORE = 650;
export declare const PRODUCT_SEARCH_CONFIDENT_MIN_SCORE = 800;
export declare const PRODUCT_RELEVANCE_SCORE_THRESHOLD = 600;
export interface RankableCatalogProduct {
    title: string;
    handle?: string | null;
    vendor?: string | null;
    productType?: string | null;
    tags?: string[] | null;
    isbn?: string | null;
    variants: Array<{
        sku?: string | null;
        isbn?: string | null;
        barcode?: string | null;
    }>;
}
export declare function normalizeForMatch(s: string): string;
export declare function scoreCatalogProduct(queryOriginal: string, probableTitle: string, product: RankableCatalogProduct): {
    score: number;
    matchReason: string;
};
export declare function rankCatalogProductsForVoice<T extends RankableCatalogProduct>(queryOriginal: string, probableTitle: string, products: T[], maxResults: number): {
    ranked: Array<T & {
        relevanceScore: number;
        matchReason: string;
    }>;
    rankedForLog: Array<{
        title: string;
        score: number;
        matchReason: string;
    }>;
    bestScore: number;
    bestReason: string | null;
    lowConfidence: boolean;
    productsAfterRanking: number;
    topProduct: string | null;
};
