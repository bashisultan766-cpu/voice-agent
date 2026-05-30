import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceStreamMetricsService } from '../../calls/runtime/voice-stream-metrics.service';
import type { VoiceStreamMetrics } from '@bookstore-voice-agents/types';

export type FullDuplexMetricsPatch = Partial<
  Pick<
    VoiceStreamMetrics,
    | 'timeToFirstAudioMs'
    | 'sttLatencyMs'
    | 'agentLatencyMs'
    | 'ttsFirstChunkMs'
    | 'shopifyLatencyMs'
    | 'interruptionCount'
    | 'fallbackCount'
    | 'lastFallbackReason'
    | 'pipelineMode'
    | 'streamingMode'
    | 'streamingStatus'
    | 'totalVoiceTurnLatencyMs'
    | 'llmLatencyMs'
    | 'ttsLatencyMs'
    | 'searchLatencyMs'
    | 'chunksEmitted'
    | 'chunksPlayed'
    | 'agentSpeaking'
    | 'partialTranscript'
  >
>;

@Injectable()
export class RealtimeVoiceMetricsService {
  constructor(private readonly streamMetrics: VoiceStreamMetricsService) {}

  async record(callSessionId: string, patch: FullDuplexMetricsPatch): Promise<void> {
    await this.streamMetrics.merge(callSessionId, {
      streamingMode: 'media_stream',
      pipelineMode: 'full_duplex',
      ...patch,
    });
  }

  async recordFallback(callSessionId: string, reason: string): Promise<void> {
    const cur = await this.streamMetrics.load(callSessionId);
    await this.streamMetrics.merge(callSessionId, {
      fallbackCount: (cur.fallbackCount ?? 0) + 1,
      lastFallbackReason: reason,
      streamingStatus: 'idle',
      agentSpeaking: false,
    });
  }

  async recordBargeIn(callSessionId: string): Promise<void> {
    await this.streamMetrics.recordBargeIn(callSessionId);
  }

  async recordPartialTranscript(callSessionId: string, partial: string): Promise<void> {
    await this.streamMetrics.recordPartialTranscript(callSessionId, partial);
  }
}
