import { Injectable } from '@nestjs/common';
import { CallsService } from '../calls.service';
import { TranscriptBufferService } from './transcript-buffer.service';
import { VoiceStreamMetricsService } from './voice-stream-metrics.service';
import { VoiceCostAnalyticsService } from './voice-cost-analytics.service';
import type { VoiceStreamMetrics, VoiceCostMetrics } from '@bookstore-voice-agents/types';

export type VoiceLiveMonitorSnapshot = {
  callSessionId: string;
  conversationStage: string | null;
  orderState: string | null;
  streamingStatus: VoiceStreamMetrics['streamingStatus'];
  streamingMode: VoiceStreamMetrics['streamingMode'];
  agentSpeaking: boolean;
  bargeInRequested: boolean;
  interruptionCount: number;
  partialTranscript: string | null;
  deferredJobPhase: string | null;
  latency: {
    sttMs: number | null;
    llmMs: number | null;
    ttsMs: number | null;
    toolMs: number | null;
    llmTimeToFirstTokenMs: number | null;
  };
  cost: VoiceCostMetrics;
  recentTranscript: Array<{ role: string; content: string; at?: string }>;
  activeTools: string[];
  updatedAt: string;
};

@Injectable()
export class VoiceLiveMonitorService {
  constructor(
    private readonly callsService: CallsService,
    private readonly transcriptBuffer: TranscriptBufferService,
    private readonly streamMetrics: VoiceStreamMetricsService,
    private readonly voiceCost: VoiceCostAnalyticsService,
  ) {}

  async snapshot(callSessionId: string): Promise<VoiceLiveMonitorSnapshot | null> {
    const session = await this.callsService.findOneById(callSessionId);
    const meta = (session.metadata ?? {}) as Record<string, unknown>;
    const metrics = await this.streamMetrics.load(callSessionId);
    const cost = await this.voiceCost.load(callSessionId);
    const mem = meta.conversationMemory as Record<string, unknown> | undefined;
    const job = meta.deferredVoiceJob as { phase?: string } | undefined;
    const history = await this.transcriptBuffer.getConversationHistory(callSessionId, 8);
    const enabledTools = Array.isArray(meta.enabledToolsSnapshot)
      ? (meta.enabledToolsSnapshot as string[])
      : [];

    return {
      callSessionId,
      conversationStage:
        typeof mem?.conversationStage === 'string'
          ? mem.conversationStage
          : typeof meta.conversationStage === 'string'
            ? meta.conversationStage
            : null,
      orderState: typeof meta.orderState === 'string' ? meta.orderState : null,
      streamingStatus: metrics.streamingStatus ?? 'idle',
      streamingMode: metrics.streamingMode ?? 'gather_deferred',
      agentSpeaking: metrics.agentSpeaking === true || meta.agentSpeaking === true,
      bargeInRequested: meta.bargeInRequested === true,
      interruptionCount: metrics.interruptionCount ?? 0,
      partialTranscript: metrics.partialTranscript ?? null,
      deferredJobPhase: job?.phase ?? null,
      latency: {
        sttMs: metrics.sttLatencyMs ?? null,
        llmMs: metrics.llmLatencyMs ?? null,
        ttsMs: metrics.ttsLatencyMs ?? null,
        toolMs: metrics.toolLatencyMs ?? null,
        llmTimeToFirstTokenMs: metrics.llmTimeToFirstTokenMs ?? null,
      },
      cost,
      recentTranscript: history.map((h) => ({ role: h.role, content: h.content.slice(0, 280) })),
      activeTools: enabledTools,
      updatedAt: metrics.lastUpdatedAt ?? new Date().toISOString(),
    };
  }
}
