import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
export declare class ShopifyService {
    private readonly config;
    private readonly prisma;
    private readonly encryption;
    constructor(config: ConfigService, prisma: PrismaService, encryption: EncryptionService);
    private stateSecret;
    private appKey;
    private appSecret;
    private callbackUrl;
    private webhookAddress;
    private normalizeShopDomain;
    private shopUrlCandidates;
    private encodeState;
    private decodeState;
    private verifyOAuthHmac;
    buildInstallUrl(tenantId: string, agentId: string, shop: string): string;
    private fetchShopifyRest;
    private listWebhooks;
    private ensureWebhooksRegistered;
    handleOAuthCallback(query: URLSearchParams): Promise<{
        redirectUrl: string;
    }>;
    verifyWebhookSignature(rawBody: Buffer, signatureB64: string): boolean;
    getConnectionStatus(tenantId: string, agentId: string): Promise<{
        agentId: string;
        agentName: string;
        connected: boolean;
        shopDomain: string | null;
        status: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        webhookTopics: string[];
    }>;
    private actionFromTopic;
    private failureActionFromTopic;
    private tenantIdsForShopDomain;
    recordWebhookFailure(topic: string, shopDomain: string, reason: string, payload?: unknown): Promise<void>;
    getWebhookHealth(tenantId: string, agentId: string): Promise<{
        agentId: string;
        connected: boolean;
        shopDomain: null;
        lastSyncedAt: null;
        lastReceivedAtByTopic: Record<string, string | null>;
        lastFailureAtByTopic: Record<string, string | null>;
        failureCount24hByTopic: Record<string, number>;
        totalFailures24h: number;
        freshness: "disconnected";
        latestReceivedAt?: undefined;
    } | {
        agentId: string;
        connected: boolean;
        shopDomain: string;
        lastSyncedAt: string | null;
        lastReceivedAtByTopic: Record<string, string | null>;
        lastFailureAtByTopic: Record<string, string | null>;
        failureCount24hByTopic: Record<string, number>;
        totalFailures24h: number;
        freshness: string;
        latestReceivedAt: string;
    }>;
    disconnect(tenantId: string, agentId: string): Promise<{
        disconnected: boolean;
    }>;
    private parseTopicEntity;
    private normalizeEmail;
    private maskEmail;
    private shouldStoreFullWebhookPayload;
    private minimalWebhookPayload;
    private paymentStatusFromOrder;
    private checkoutStatusFromPaymentStatus;
    private findCheckoutLinkForOrder;
    private reconcileOrderWebhookForTenant;
    handleWebhook(topic: string, shopDomain: string, payload: unknown): Promise<void>;
}
