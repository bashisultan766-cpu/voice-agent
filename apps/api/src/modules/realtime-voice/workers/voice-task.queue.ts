import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { normalizeRedisUrl } from '../../../common/redis-client.util';

export type VoiceTaskName = 'post-turn' | 'catalog-warm' | 'email-retry' | 'analytics-flush';

@Injectable()
export class VoiceTaskQueueService {
  private queue: Queue | null = null;

  constructor(private readonly config: ConfigService) {}

  private getQueue(): Queue | null {
    if (this.queue) return this.queue;
    const connection = normalizeRedisUrl(this.config.get<string>('REDIS_URL'));
    if (!connection) return null;
    this.queue = new Queue('voice-background-tasks', { connection: { url: connection } });
    return this.queue;
  }

  async enqueue(name: VoiceTaskName, data: Record<string, unknown>): Promise<void> {
    const queue = this.getQueue();
    if (!queue) return;
    await queue.add(name, data, {
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }
}
