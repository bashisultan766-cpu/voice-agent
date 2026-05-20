import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
export declare class ShopifyClientService {
    private readonly prisma;
    private readonly encryption;
    constructor(prisma: PrismaService, encryption: EncryptionService);
    private normalizeDomain;
    getAgentShopifyConfig(tenantId: string, agentId: string): Promise<{
        domain: string;
        token: string;
        shopifyConnectionId: string | null;
    }>;
    private parseGraphqlPayload;
    private executeGraphqlOnce;
    adminGraphql<T>(domain: string, token: string, query: string, variables?: Record<string, unknown>): Promise<T>;
    adminRest<T>(domain: string, token: string, path: string, init?: RequestInit): Promise<T>;
}
