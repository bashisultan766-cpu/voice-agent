import { Injectable } from '@nestjs/common';
import { CallsService } from '../calls.service';
import { VoiceStreamMetricsService } from './voice-stream-metrics.service';

/** Per-call streaming + barge-in coordination (metadata-backed). */
@Injectable()
export class VoiceStreamingSessionService {
  constructor(
    private readonly callsService: CallsService,
    private readonly streamMetrics: VoiceStreamMetricsService,
  ) {}

  async isBargeInRequested(callSessionId: string): Promise<boolean> {
    const row = await this.callsService.findOneById(callSessionId);
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    return meta.bargeInRequested === true;
  }

  async requestBargeIn(callSessionId: string): Promise<void> {
    await this.callsService.mergeSessionMetadata(callSessionId, {
      bargeInRequested: true,
      agentSpeaking: false,
    });
    await this.streamMetrics.recordBargeIn(callSessionId);
  }

  async clearBargeIn(callSessionId: string): Promise<void> {
    await this.callsService.mergeSessionMetadata(callSessionId, { bargeInRequested: false });
  }

  /** Cancel in-flight deferred job when caller speaks over agent audio. */
  async cancelDeferredJobForBargeIn(callSessionId: string): Promise<boolean> {
    const row = await this.callsService.findOneById(callSessionId);
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const job = meta.deferredVoiceJob as { phase?: string; jobId?: string } | undefined;
    if (!job || job.phase !== 'processing') return false;
    await this.requestBargeIn(callSessionId);
    await this.callsService.mergeSessionMetadata(callSessionId, {
      deferredVoiceJob: {
        jobId: job.jobId,
        phase: 'failed',
        startedAtMs: Date.now(),
        errorMessage: 'barge_in_interrupted',
      },
    });
    return true;
  }
}
