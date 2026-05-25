import { Injectable } from '@nestjs/common';
import type { VoiceCostMetrics } from '@bookstore-voice-agents/types';
import { PrismaService } from '../../../database/prisma.service';

const COST_KEY = 'voiceCostMetrics';

/** Rough USD estimates — override via env for billing alignment. */
const DEFAULT_OPENAI_INPUT_PER_1M = Number(process.env.VOICE_COST_OPENAI_INPUT_PER_1M_USD) || 2.5;
const DEFAULT_OPENAI_OUTPUT_PER_1M = Number(process.env.VOICE_COST_OPENAI_OUTPUT_PER_1M_USD) || 10;
const DEFAULT_ELEVENLABS_PER_1K_CHARS = Number(process.env.VOICE_COST_ELEVENLABS_PER_1K_CHARS_USD) || 0.3;

@Injectable()
export class VoiceCostAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async load(callSessionId: string): Promise<VoiceCostMetrics> {
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const meta = (session?.metadata ?? {}) as Record<string, unknown>;
    const raw = meta[COST_KEY];
    if (raw && typeof raw === 'object') return raw as VoiceCostMetrics;
    return {};
  }

  async recordOpenAiUsage(
    callSessionId: string,
    usage: { promptTokens?: number; completionTokens?: number },
  ): Promise<VoiceCostMetrics> {
    const cur = await this.load(callSessionId);
    const inTok = (cur.openaiInputTokens ?? 0) + (usage.promptTokens ?? 0);
    const outTok = (cur.openaiOutputTokens ?? 0) + (usage.completionTokens ?? 0);
    const openaiEstimatedUsd =
      (inTok / 1_000_000) * DEFAULT_OPENAI_INPUT_PER_1M +
      (outTok / 1_000_000) * DEFAULT_OPENAI_OUTPUT_PER_1M;
    const elevenUsd = cur.elevenlabsEstimatedUsd ?? 0;
    return this.merge(callSessionId, {
      openaiInputTokens: inTok,
      openaiOutputTokens: outTok,
      openaiEstimatedUsd: Number(openaiEstimatedUsd.toFixed(6)),
      totalEstimatedUsd: Number((openaiEstimatedUsd + elevenUsd).toFixed(6)),
      turns: (cur.turns ?? 0) + 1,
    });
  }

  async recordElevenLabsUsage(callSessionId: string, characterCount: number): Promise<VoiceCostMetrics> {
    const cur = await this.load(callSessionId);
    const chars = (cur.elevenlabsCharacters ?? 0) + characterCount;
    const elevenlabsEstimatedUsd = (chars / 1000) * DEFAULT_ELEVENLABS_PER_1K_CHARS;
    const openaiUsd = cur.openaiEstimatedUsd ?? 0;
    return this.merge(callSessionId, {
      elevenlabsCharacters: chars,
      elevenlabsEstimatedUsd: Number(elevenlabsEstimatedUsd.toFixed(6)),
      totalEstimatedUsd: Number((openaiUsd + elevenlabsEstimatedUsd).toFixed(6)),
    });
  }

  async recordCheckoutCost(callSessionId: string): Promise<void> {
    const cur = await this.load(callSessionId);
    const total = cur.totalEstimatedUsd ?? 0;
    await this.merge(callSessionId, { costPerCheckoutUsd: total });
  }

  private async merge(callSessionId: string, patch: Partial<VoiceCostMetrics>): Promise<VoiceCostMetrics> {
    const current = await this.load(callSessionId);
    const next = { ...current, ...patch };
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const meta = { ...((session?.metadata ?? {}) as Record<string, unknown>), [COST_KEY]: next };
    await this.prisma.callSession.update({
      where: { id: callSessionId },
      data: { metadata: meta as object },
    });
    return next;
  }
}
