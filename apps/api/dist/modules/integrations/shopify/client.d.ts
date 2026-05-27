import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
export declare class ShopifyClientService {
    private readonly prisma;
    private readonly encryption;
    private readonly logger;
    constructor(prisma: PrismaService, encryption: EncryptionService);
    private normalizeDomain;
    getAgentShopifyConfig(tenantId: string, agentId: string): Promise<{
        domain: string;
        token: string;
        shopifyConnectionId: string | null;
        apiVersion: string;
        source: string;
    }>;
    private parseGraphqlPayload;
    private executeGraphqlOnce;
    adminGraphql<T = unknown>(domain: string, token: string, query: string, variables?: Record<string, unknown>, apiVersion?: string): Promise<T>;
    adminRest(domain: string, token: string, path: string, init?: RequestInit, apiVersion?: string): Promise<unknown>;
}
