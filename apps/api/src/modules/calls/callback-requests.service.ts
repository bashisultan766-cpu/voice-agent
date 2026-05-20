import { Injectable } from '@nestjs/common';
import { CallbackRequestStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

interface CreateCallbackRequestInput {
  tenantId: string;
  agentId: string;
  callSessionId?: string;
  phone: string;
  reason: string;
  priority?: 'low' | 'normal' | 'high';
  notes?: string;
}

@Injectable()
export class CallbackRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateCallbackRequestInput) {
    return this.prisma.callbackRequest.create({
      data: {
        tenantId: input.tenantId,
        agentId: input.agentId,
        callSessionId: input.callSessionId ?? undefined,
        phone: input.phone.trim(),
        reason: input.reason.trim(),
        priority: input.priority ?? 'normal',
        notes: input.notes?.trim() || null,
      },
    });
  }

  async listForTenant(
    tenantId: string,
    options: { status?: CallbackRequestStatus; limit?: number } = {},
  ) {
    return this.prisma.callbackRequest.findMany({
      where: {
        tenantId,
        ...(options.status ? { status: options.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
  }

  async updateStatus(tenantId: string, id: string, status: CallbackRequestStatus) {
    await this.prisma.callbackRequest.updateMany({
      where: { id, tenantId },
      data: { status },
    });
    return this.prisma.callbackRequest.findFirst({
      where: { id, tenantId },
    });
  }

  async markRequestedOnSession(callSessionId: string): Promise<void> {
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    if (!session) return;
    const metadata = ((session.metadata as Prisma.JsonObject | null) ?? {}) as Record<string, unknown>;
    metadata.callbackRequested = true;
    await this.prisma.callSession.update({
      where: { id: callSessionId },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
