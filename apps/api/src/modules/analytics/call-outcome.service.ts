import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CallResolutionStatus } from '@prisma/client';

@Injectable()
export class CallOutcomeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Derive and upsert CallOutcome from CallSession + ToolExecutions.
   * Call when call ends (e.g. onRuntimeDisconnected or status callback).
   */
  async deriveAndUpsert(callSessionId: string): Promise<void> {
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      include: {
        toolExecutions: true,
      },
    });
    if (!session) return;

    const toolsUsed = session.toolExecutions.length;
    const toolFailures = session.toolExecutions.filter((t) => t.status === 'FAILED').length;
    const escalated = session.escalated ?? false;
    const metadata = (session.metadata as Record<string, unknown>) ?? {};
    const callbackRequested = Boolean(metadata.callbackRequested);

    let resolutionStatus: CallResolutionStatus;
    if (session.status === 'ABANDONED' || session.endedReason === 'abandoned') {
      resolutionStatus = CallResolutionStatus.ABANDONED;
    } else if (escalated || callbackRequested) {
      resolutionStatus = CallResolutionStatus.ESCALATED;
    } else if (toolFailures > 2 || (toolFailures > 0 && toolsUsed <= 1)) {
      resolutionStatus = CallResolutionStatus.UNRESOLVED;
    } else if (toolFailures > 0 || callbackRequested) {
      resolutionStatus = CallResolutionStatus.PARTIALLY_RESOLVED;
    } else {
      resolutionStatus = CallResolutionStatus.RESOLVED;
    }

    await this.prisma.callOutcome.upsert({
      where: { callSessionId },
      create: {
        tenantId: session.tenantId,
        callSessionId: session.id,
        resolutionStatus,
        toolsUsedCount: toolsUsed,
        toolFailuresCount: toolFailures,
        escalated,
        callbackRequested,
        summary: session.summary ?? undefined,
      },
      update: {
        resolutionStatus,
        toolsUsedCount: toolsUsed,
        toolFailuresCount: toolFailures,
        escalated,
        callbackRequested,
        summary: session.summary ?? undefined,
      },
    });
  }

  async getByCallSession(callSessionId: string) {
    return this.prisma.callOutcome.findUnique({
      where: { callSessionId },
    });
  }

  async update(
    tenantId: string,
    callSessionId: string,
    data: {
      resolutionStatus?: CallResolutionStatus;
      primaryIntent?: string;
      secondaryIntent?: string;
      summary?: string;
      qaScore?: number;
    },
  ) {
    await this.prisma.callOutcome.updateMany({
      where: { callSessionId, tenantId },
      data,
    });
    return this.getByCallSession(callSessionId);
  }
}
