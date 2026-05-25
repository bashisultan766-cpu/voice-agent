import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CallResolutionStatus, CallStatus, Prisma, ToolExecutionStatus } from '@prisma/client';

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
    const toolFailures = session.toolExecutions.filter((t) => t.status === ToolExecutionStatus.FAILED).length;
    const escalated = session.escalated ?? false;
    const metadata = (session.metadata as Record<string, unknown>) ?? {};
    const callbackRequested = Boolean(metadata.callbackRequested);
    const mem = (metadata.conversationMemory ?? {}) as Record<string, unknown>;
    const productsRequested = Array.isArray(mem.mentionedProducts)
      ? (mem.mentionedProducts as Array<{ title?: string }>)
          .map((p) => p.title)
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [];
    const paymentTools = session.toolExecutions.filter((t) =>
      ['sendPaymentEmail', 'createCheckoutLink', 'createCheckoutOrInvoicePaymentLink', 'create_payment_checkout_link'].includes(
        t.toolName,
      ),
    );
    const paymentLinkSent = paymentTools.some((t) => t.status === 'SUCCESS');
    const orderCompleted = session.toolExecutions.some(
      (t) => t.toolName === 'get_order_status' && t.status === 'SUCCESS',
    );
    const escalationReason =
      typeof metadata.escalationReason === 'string'
        ? metadata.escalationReason
        : session.escalated
          ? 'escalated'
          : null;
    let conversionOutcome = 'none';
    if (orderCompleted) conversionOutcome = 'order_completed';
    else if (paymentLinkSent) conversionOutcome = 'payment_link_sent';
    else if (session.escalated || callbackRequested) conversionOutcome = 'escalated';

    let resolutionStatus: CallResolutionStatus;
    if (session.status === CallStatus.ABANDONED || session.endedReason === 'abandoned') {
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
        primaryIntent: typeof metadata.lastUserIntent === 'string' ? metadata.lastUserIntent : undefined,
        productsRequested: productsRequested.length ? (productsRequested as Prisma.InputJsonValue) : undefined,
        conversionOutcome,
        paymentLinkSent,
        orderCompleted,
        escalationReason: escalationReason ?? undefined,
        analyticsMeta: {
          toolNames: session.toolExecutions.map((t) => t.toolName),
          durationSeconds: session.durationSeconds,
        },
      },
      update: {
        resolutionStatus,
        toolsUsedCount: toolsUsed,
        toolFailuresCount: toolFailures,
        escalated,
        callbackRequested,
        summary: session.summary ?? undefined,
        primaryIntent: typeof metadata.lastUserIntent === 'string' ? metadata.lastUserIntent : undefined,
        productsRequested: productsRequested.length ? (productsRequested as Prisma.InputJsonValue) : undefined,
        conversionOutcome,
        paymentLinkSent,
        orderCompleted,
        escalationReason: escalationReason ?? undefined,
        analyticsMeta: {
          toolNames: session.toolExecutions.map((t) => t.toolName),
          durationSeconds: session.durationSeconds,
        },
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
