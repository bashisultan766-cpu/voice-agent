import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from './client';
import { Prisma } from '@prisma/client';
export type RepairedVariantCacheRow = Prisma.VariantCacheGetPayload<{
    include: {
        product: {
            select: {
                title: true;
                shopifyProductId: true;
            };
        };
    };
}>;
export declare class ShopifyProductSyncService {
    private readonly prisma;
    private readonly shopifyClient;
    private readonly logger;
    constructor(prisma: PrismaService, shopifyClient: ShopifyClientService);
    syncProducts(tenantId: string, agentId: string): Promise<{
        syncedProducts: number;
        syncedVariants: number;
        shopDomain: string;
    }>;
    repairVariantCacheFromShopify(tenantId: string, agentId: string, shopDomain: string, rawKey: string): Promise<RepairedVariantCacheRow | null>;
    private upsertProductCacheRow;
    private fetchAllVariantNodes;
    private logSyncFailure;
}
