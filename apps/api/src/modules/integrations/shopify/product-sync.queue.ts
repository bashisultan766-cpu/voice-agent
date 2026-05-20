import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

@Injectable()
export class ShopifyProductSyncQueueService {
  private queue: Queue | null = null;

  constructor(private readonly config: ConfigService) {}

  private getQueue(): Queue {
    if (this.queue) return this.queue;
    const connection = this.config.get<string>('REDIS_URL')?.trim();
    if (!connection) throw new Error('REDIS_URL is not configured for product sync queue.');
    this.queue = new Queue('shopify-product-sync', { connection: { url: connection } });
    return this.queue;
  }

  async enqueue(tenantId: string, agentId: string) {
    const queue = this.getQueue();
    await queue.add(
      'sync-products',
      { tenantId, agentId },
      {
        removeOnComplete: 50,
        removeOnFail: 100,
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
      },
    );
  }
}
