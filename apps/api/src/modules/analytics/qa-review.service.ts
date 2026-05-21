import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TERMINAL_CALL_STATUSES } from '../../database/prisma.types';

@Injectable()
export class QaReviewService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List calls for QA queue: optional tenant filter, optional flagged.
   */
  async listCallsForQa(tenantId: string, options?: { limit?: number; hasOutcome?: boolean }) {
    const limit = options?.limit ?? 50;
    const sessions = await this.prisma.callSession.findMany({
      where: {
        tenantId,
        status: { in: TERMINAL_CALL_STATUSES },
        ...(options?.hasOutcome !== undefined && {
          callOutcome: options.hasOutcome ? { isNot: null } : { is: null },
        }),
      },
      orderBy: { endedAt: 'desc' },
      take: limit,
      include: {
        callOutcome: true,
        agent: { select: { id: true, name: true } },
        store: { select: { id: true, name: true } },
        _count: { select: { toolExecutions: true } },
      },
    });
    return sessions;
  }

  /**
   * Full QA detail: session, transcripts, tool executions, events, outcome.
   */
  async getQaDetail(callSessionId: string, tenantId: string) {
    const session = await this.prisma.callSession.findFirst({
      where: { id: callSessionId, tenantId },
      include: {
        callOutcome: true,
        callEvents: { orderBy: { timestamp: 'asc' } },
        transcripts: { orderBy: { sequenceNumber: 'asc' } },
        toolExecutions: { orderBy: { createdAt: 'asc' } },
        agent: { select: { id: true, name: true, baseSystemPrompt: true } },
        store: { select: { id: true, name: true } },
      },
    });
    if (!session) throw new NotFoundException('Call not found');
    return session;
  }

  /**
   * Submit QA review: create AgentQualityReview, optionally update CallOutcome.qaScore.
   */
  async submitReview(
    tenantId: string,
    callSessionId: string,
    data: {
      reviewerUserId?: string;
      accuracyScore?: number;
      toneScore?: number;
      policyComplianceScore?: number;
      brevityScore?: number;
      notes?: string;
      needsPromptUpdate?: boolean;
      needsFaqUpdate?: boolean;
    },
  ) {
    const session = await this.prisma.callSession.findFirst({
      where: { id: callSessionId, tenantId },
      select: { id: true, agentId: true },
    });
    if (!session) throw new NotFoundException('Call not found');

    const review = await this.prisma.agentQualityReview.create({
      data: {
        tenantId,
        agentId: session.agentId,
        callSessionId: session.id,
        reviewerUserId: data.reviewerUserId,
        accuracyScore: data.accuracyScore,
        toneScore: data.toneScore,
        policyComplianceScore: data.policyComplianceScore,
        brevityScore: data.brevityScore,
        notes: data.notes,
        needsPromptUpdate: data.needsPromptUpdate ?? false,
        needsFaqUpdate: data.needsFaqUpdate ?? false,
      },
    });

    const scores = [data.accuracyScore, data.toneScore, data.policyComplianceScore, data.brevityScore].filter(
      (s): s is number => typeof s === 'number',
    );
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    if (avgScore > 0) {
      await this.prisma.callOutcome.updateMany({
        where: { callSessionId, tenantId },
        data: { qaScore: Math.round(avgScore * 100) / 100 },
      });
    }
    return review;
  }
}
