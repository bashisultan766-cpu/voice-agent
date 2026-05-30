import { Injectable } from '@nestjs/common';
import { CallEventsService } from '../../analytics/call-events.service';
import { VoiceStreamMetricsService } from '../../calls/runtime/voice-stream-metrics.service';
import { VoiceEventBusService } from '../events/voice-event-bus.service';
import { CallEventType } from '@prisma/client';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';

@Injectable()
export class AnalyticsAgent {
  constructor(
    private readonly callEvents: CallEventsService,
    private readonly streamMetrics: VoiceStreamMetricsService,
    private readonly events: VoiceEventBusService,
  ) {}

  async recordTurn(
    state: VoiceGraphState,
    agentResults: AgentTaskResult[],
    totalLatencyMs: number,
  ): Promise<AgentTaskResult> {
    const started = Date.now();
    const { tenantId } = state.context;

    await Promise.all([
      this.callEvents.log(tenantId, state.callSessionId, CallEventType.TRANSCRIPT_CHUNK_ADDED, {
        intent: state.intent,
        modelUsed: state.modelUsed,
        totalLatencyMs,
        agentCount: agentResults.length,
        agents: agentResults.map((r) => ({ agent: r.agent, ok: r.ok, latencyMs: r.latencyMs })),
      }),
      this.streamMetrics.merge(state.callSessionId, {
        llmLatencyMs: totalLatencyMs,
        streamingMode: 'gather_deferred',
      }),
    ]);

    this.events.emit('analytics.recorded', {
      callSessionId: state.callSessionId,
      tenantId,
      intent: state.intent,
      latencyMs: totalLatencyMs,
    });

    return {
      agent: 'analytics',
      ok: true,
      latencyMs: Date.now() - started,
    };
  }
}
