import { ConfigService } from '@nestjs/config';
export declare class ShopifyProductSyncQueueService {
    private readonly config;
    private queue;
    constructor(config: ConfigService);
    private getQueue;
    enqueue(tenantId: string, agentId: string): Promise<void>;
}
