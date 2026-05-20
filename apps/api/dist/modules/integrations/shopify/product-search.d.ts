import { PrismaService } from '../../../database/prisma.service';
type ProductCandidate = {
    productId: string;
    title: string;
    handle: string | null;
    vendor: string | null;
    productType: string | null;
    status: string | null;
    tags: string | null;
    isbn: string | null;
    variants: Array<{
        variantId: string;
        title: string | null;
        sku: string | null;
        isbn: string | null;
        price: string | null;
        compareAtPrice: string | null;
        inventoryQuantity: number;
        availableForSale: boolean;
    }>;
    syncedAt: Date;
};
export declare class ShopifyProductSearchService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    private readonly isbnKeyPattern;
    private readonly isbnTextPattern;
    search(tenantId: string, query: string, limit?: number, shopDomain?: string | null): Promise<{
        productId: string;
        title: string;
        handle: string | null;
        vendor: string | null;
        productType: string | null;
        status: string | null;
        tags: string | null;
        isbn: string | null;
        variants: {
            variantId: string;
            title: string | null;
            sku: string | null;
            isbn: string | null;
            price: string | null;
            compareAtPrice: string | null;
            inventoryQuantity: number;
            availableForSale: boolean;
        }[];
        syncedAt: Date;
    }[]>;
    fuzzySearch(tenantId: string, query: string, limit?: number, shopDomain?: string | null): Promise<{
        confidence: number;
        results: ProductCandidate[];
        normalizedQuery: string;
    }>;
    getDetails(tenantId: string, lookup: {
        productId?: string;
        variantId?: string;
        title?: string;
    }, shopDomain?: string | null): Promise<{
        selectedVariantId: string | null;
        productId: string;
        title: string;
        handle: string | null;
        vendor: string | null;
        productType: string | null;
        status: string | null;
        tags: string | null;
        isbn: string | null;
        variants: {
            variantId: string;
            title: string | null;
            sku: string | null;
            isbn: string | null;
            price: string | null;
            compareAtPrice: string | null;
            inventoryQuantity: number;
            availableForSale: boolean;
        }[];
        syncedAt: Date;
    } | null>;
    private mapProduct;
    private normalizeProductQuery;
    private synonymsForToken;
    private scoreMatch;
    private similarity;
    private levenshtein;
    private soundex;
    private readMetafields;
    private pickIsbn;
    private extractIsbnText;
    private normalizeIsbn;
}
export {};
