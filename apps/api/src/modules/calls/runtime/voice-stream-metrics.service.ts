import { Injectable } from '@nestjs/common';
import type { VoiceStreamMetrics } from '@bookstore-voice-agents/types';
import { PrismaService } from '../../../database/prisma.service';

const METRICS_KEY = 'voiceStreamMetrics';

@Injectable()
export class VoiceStreamMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async load(callSessionId: string): Promise<VoiceStreamMetrics> {
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const meta = (session?.metadata ?? {}) as Record<string, unknown>;
    const raw = meta[METRICS_KEY];
    if (raw && typeof raw === 'object') return raw as VoiceStreamMetrics;
    return {};
  }

  async merge(callSessionId: string, patch: Partial<VoiceStreamMetrics>): Promise<VoiceStreamMetrics> {
    const current = await this.load(callSessionId);
    const next: VoiceStreamMetrics = {
      ...current,
      ...patch,
      lastUpdatedAt: new Date().toISOString(),
    };
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const meta = { ...((session?.metadata ?? {}) as Record<string, unknown>), [METRICS_KEY]: next };
    await this.prisma.callSession.update({
      where: { id: callSessionId },
      data: { metadata: meta as object },
    });
    return next;
  }

  async recordBargeIn(callSessionId: string): Promise<void> {
    const cur = await this.load(callSessionId);
    await this.merge(callSessionId, {
      interruptionCount: (cur.interruptionCount ?? 0) + 1,
      lastBargeInAt: new Date().toISOString(),
      streamingStatus: 'interrupted',
      agentSpeaking: false,
    });
  }

  async recordPartialTranscript(callSessionId: string, partial: string): Promise<void> {
    await this.merge(callSessionId, {
      partialTranscript: partial.slice(0, 500),
      streamingStatus: 'listening',
    });
  }

  async markSpeaking(callSessionId: string, speaking: boolean): Promise<void> {
    await this.merge(callSessionId, {
      agentSpeaking: speaking,
      streamingStatus: speaking ? 'speaking' : 'listening',
    });
  }
}
