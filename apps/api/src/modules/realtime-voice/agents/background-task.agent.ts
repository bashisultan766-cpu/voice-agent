import { Injectable, Logger } from '@nestjs/common';
import { VoiceTaskQueueService } from '../workers/voice-task.queue';
import type { VoiceGraphState } from '../types/voice-turn.types';

/**
 * Background Task Agent — enqueues non-blocking work (email retry, analytics flush, catalog warm).
 */
@Injectable()
export class BackgroundTaskAgent {
  private readonly logger = new Logger(BackgroundTaskAgent.name);

  constructor(private readonly queue: VoiceTaskQueueService) {}

  async enqueuePostTurnTasks(state: VoiceGraphState): Promise<void> {
    try {
      await this.queue.enqueue('post-turn', {
        callSessionId: state.callSessionId,
        tenantId: state.context.tenantId,
        agentId: state.context.agentId,
        intent: state.intent,
        replyLength: state.reply.length,
      });
    } catch (err) {
      this.logger.warn(`BackgroundTaskAgent enqueue failed: ${(err as Error).message}`);
    }
  }

  async enqueueCatalogWarm(tenantId: string, agentId: string): Promise<void> {
    try {
      await this.queue.enqueue('catalog-warm', { tenantId, agentId });
    } catch {
      /* non-fatal */
    }
  }
}
