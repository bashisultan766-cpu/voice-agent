import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from './client';
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
    private fetchAllVariantNodes;
    private logSyncFailure;
}
