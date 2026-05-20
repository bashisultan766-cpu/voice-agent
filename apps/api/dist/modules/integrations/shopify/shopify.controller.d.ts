import { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ShopifyService } from './shopify.service';
export declare class ShopifyController {
    private readonly shopify;
    constructor(shopify: ShopifyService);
    private readonly logger;
    status(tenantId: string, agentId: string): Promise<{
        agentId: string;
        agentName: string;
        connected: boolean;
        shopDomain: string | null;
        status: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        webhookTopics: string[];
    }>;
    health(tenantId: string, agentId: string): Promise<{
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
    oauthStart(tenantId: string, agentId: string, shop: string, res: Response): Promise<void>;
    disconnect(tenantId: string, body: {
        agentId?: string;
    }): Promise<{
        disconnected: boolean;
    }>;
    oauthCallback(req: Request, res: Response): Promise<void>;
    webhooks(req: RawBodyRequest<Request>, res: Response, topic: string, shopDomain: string, signature: string, parsedBody: unknown): Promise<Response<any, Record<string, any>>>;
}
