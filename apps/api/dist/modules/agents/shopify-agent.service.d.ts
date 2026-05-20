import { AgentsService } from './agents.service';
export interface ShopifyOrderSummary {
    id: string;
    name: string;
    financial_status: string;
    fulfillment_status: string | null;
    created_at: string;
    total_price: string;
    note?: string;
}
export interface ShopifyProductSummary {
    id: string;
    productId: string;
    title: string;
    handle?: string | null;
    status: string;
    vendor?: string | null;
    productType?: string | null;
    tags?: string[];
    isbn?: string | null;
    variants: Array<{
        id: string;
        title: string;
        inventory_quantity: number;
        sku?: string | null;
        barcode?: string | null;
        price?: string | null;
        isbn?: string | null;
        availableForSale?: boolean;
    }>;
    relevanceScore?: number;
    matchReason?: string;
}
export interface ShopifyProductSearchVoiceLog {
    productSearchInputRaw: string;
    cleanedQuery: string;
    probableTitle: string;
    shopifyQueriesTried: Array<{
        label: string;
        query: string;
    }>;
    productsReturned: number;
    productsReturnedCount: number;
    productsAfterRanking: number;
    rankedProducts: Array<{
        title: string;
        score: number;
        matchReason: string;
    }>;
    topProduct: string | null;
    topProductTitle: string | null;
    topScore: number | null;
    topMatchReason: string | null;
    lowConfidenceSearch: boolean;
    finalVoiceSummary: string;
    queryOriginal?: string;
    normalizedQuery?: string;
    productsReturnedByShopify?: number;
    topRelevanceScore?: number | null;
    matchReason?: string | null;
}
export declare class ShopifyAgentService {
    private readonly agentsService;
    private static shopifyScalarPriceQueryLogged;
    private readonly logger;
    constructor(agentsService: AgentsService);
    private normalizeAdminDomain;
    private adminGraphql;
    private metafieldList;
    private normalizeIsbnCandidate;
    private pickIsbn;
    private isbnFromTags;
    private variantNodesFromProduct;
    private moneyScalarToString;
    private mapGraphqlProductNode;
    private fetchProductsMergedSearch;
    private fetchShopify;
    getOrderStatus(tenantId: string, agentId: string, orderNumberOrPhone: string): Promise<{
        ok: boolean;
        orders?: ShopifyOrderSummary[];
        voiceSummary?: string;
        error?: string;
    }>;
    searchProducts(tenantId: string, agentId: string, query: string, limit?: number): Promise<{
        ok: boolean;
        products?: ShopifyProductSummary[];
        voiceSummary?: string;
        error?: string;
        searchVoiceLog?: ShopifyProductSearchVoiceLog;
    }>;
    getProductLive(tenantId: string, agentId: string, lookup: {
        productId?: string;
        variantId?: string;
        title?: string;
    }): Promise<ShopifyProductSummary | null>;
    debugProductSearch(tenantId: string, agentId: string, query: string): Promise<{
        cleanedQuery: string;
        probableTitle: string;
        shopifyQueriesTried: Array<{
            label: string;
            query: string;
        }>;
        productsReturned: number;
        productsAfterRanking: number;
        topProduct: string | null;
        rawShopifyProductTitles: string[];
        rankedProducts: Array<{
            title: string;
            score: number;
            matchReason: string;
        }>;
        topScore: number | null;
        topMatchReason: string | null;
        selectedProduct: ShopifyProductSummary | null;
        selectionExplanation: string;
    }>;
}
