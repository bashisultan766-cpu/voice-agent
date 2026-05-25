import { Injectable } from '@nestjs/common';
import type { CallRuntimeAnalytics } from '@bookstore-voice-agents/types';
import { CallEventType } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CallEventsService } from '../../analytics/call-events.service';

const ANALYTICS_KEY = 'runtimeAnalytics';

@Injectable()
export class ConversationAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly callEvents: CallEventsService,
  ) {}

  async load(callSessionId: string): Promise<CallRuntimeAnalytics> {
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const meta = (session?.metadata ?? {}) as Record<string, unknown>;
    const raw = meta[ANALYTICS_KEY];
    if (raw && typeof raw === 'object') return raw as CallRuntimeAnalytics;
    return {};
  }

  async merge(
    callSessionId: string,
    tenantId: string,
    patch: Partial<CallRuntimeAnalytics>,
  ): Promise<CallRuntimeAnalytics> {
    const current = await this.load(callSessionId);
    const next: CallRuntimeAnalytics = { ...current, ...patch };

    if (patch.toolLatencyMs != null) {
      const prev = current.toolLatencyMs ?? [];
      next.toolLatencyMs = [...prev, ...patch.toolLatencyMs].slice(-50);
    }
    if (patch.objectionCounts) {
      const counts = { ...(current.objectionCounts ?? {}) };
      for (const [k, v] of Object.entries(patch.objectionCounts)) {
        counts[k] = (counts[k] ?? 0) + (typeof v === 'number' ? v : 1);
      }
      next.objectionCounts = counts;
    }

    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const meta = { ...((session?.metadata ?? {}) as Record<string, unknown>), [ANALYTICS_KEY]: next };
    await this.prisma.callSession.update({
      where: { id: callSessionId },
      data: { metadata: meta as object },
    });

    if (patch.hallucinationAttempts && patch.hallucinationAttempts > (current.hallucinationAttempts ?? 0)) {
      await this.callEvents.log(tenantId, callSessionId, CallEventType.FALLBACK_USED, {
        reason: 'hallucination_guard',
        count: next.hallucinationAttempts,
      });
    }

    return next;
  }

  async recordRecommendation(tenantId: string, callSessionId: string, ok: boolean): Promise<void> {
    const cur = await this.load(callSessionId);
    await this.merge(callSessionId, tenantId, {
      successfulRecommendations: (cur.successfulRecommendations ?? 0) + (ok ? 1 : 0),
    });
  }

  async recordCheckoutAttempt(tenantId: string, callSessionId: string): Promise<void> {
    const cur = await this.load(callSessionId);
    await this.merge(callSessionId, tenantId, {
      checkoutAttempts: (cur.checkoutAttempts ?? 0) + 1,
    });
  }

  async recordToolLatency(
    tenantId: string,
    callSessionId: string,
    ms: number,
    toolName: string,
  ): Promise<void> {
    await this.merge(callSessionId, tenantId, { toolLatencyMs: [{ toolName, ms, at: new Date().toISOString() }] });
  }

  async recordRefusal(tenantId: string, callSessionId: string, category?: string): Promise<void> {
    const cur = await this.load(callSessionId);
    await this.merge(callSessionId, tenantId, {
      refusalTriggers: (cur.refusalTriggers ?? 0) + 1,
      lastRefusalCategory: category ?? null,
    });
  }

  async recordAbandonedStage(
    tenantId: string,
    callSessionId: string,
    stage: string,
    reason?: string,
  ): Promise<void> {
    const cur = await this.load(callSessionId);
    const reasons = [...(cur.abandonedCheckoutReasons ?? [])];
    if (reason?.trim()) reasons.push(reason.trim());
    await this.merge(callSessionId, tenantId, {
      abandonedAtStage: stage,
      abandonedCheckoutReasons: reasons.slice(-10),
    });
  }

  async recordRecommendationOffer(tenantId: string, callSessionId: string): Promise<void> {
    const cur = await this.load(callSessionId);
    await this.merge(callSessionId, tenantId, {
      recommendationOffers: (cur.recommendationOffers ?? 0) + 1,
    });
  }

  async recordRecommendationOutcome(
    tenantId: string,
    callSessionId: string,
    accepted: boolean,
  ): Promise<void> {
    const cur = await this.load(callSessionId);
    await this.merge(callSessionId, tenantId, {
      recommendationAccepted: (cur.recommendationAccepted ?? 0) + (accepted ? 1 : 0),
      recommendationDeclined: (cur.recommendationDeclined ?? 0) + (accepted ? 0 : 1),
    });
  }

  async recordCheckoutConverted(tenantId: string, callSessionId: string): Promise<void> {
    const cur = await this.load(callSessionId);
    await this.merge(callSessionId, tenantId, {
      checkoutConverted: true,
      conversionEvents: (cur.conversionEvents ?? 0) + 1,
    });
  }

  async recordEstimatedOrderValue(
    tenantId: string,
    callSessionId: string,
    amount: number,
  ): Promise<void> {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const cur = await this.load(callSessionId);
    await this.merge(callSessionId, tenantId, {
      estimatedOrderValue: (cur.estimatedOrderValue ?? 0) + amount,
    });
  }
}
