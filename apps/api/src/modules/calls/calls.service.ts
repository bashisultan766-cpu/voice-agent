import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CallStatus, Prisma } from '@prisma/client';

export interface CreateCallSessionInput {
  tenantId: string;
  storeId?: string | null;
  agentId: string;
  phoneNumberId?: string | null;
  twilioCallSid: string;
  fromNumber?: string;
  toNumber?: string;
  direction?: string;
}

@Injectable()
export class CallsService {
  constructor(private readonly prisma: PrismaService) {}

  async createSession(input: CreateCallSessionInput) {
    return this.prisma.callSession.create({
      data: {
        tenantId: input.tenantId,
        storeId: input.storeId ?? undefined,
        agentId: input.agentId,
        phoneNumberId: input.phoneNumberId,
        twilioCallSid: input.twilioCallSid,
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        direction: input.direction ?? 'inbound',
        status: CallStatus.INITIATED,
        startedAt: new Date(),
      },
    });
  }

  async updateSessionStatus(
    callSessionId: string,
    data: {
      status?: CallStatus;
      answeredAt?: Date;
      endedAt?: Date;
      durationSeconds?: number;
      twilioStreamSid?: string;
      lastEventAt?: Date;
      escalated?: boolean;
      metadata?: Record<string, unknown>;
    },
  ) {
    const { metadata, ...rest } = data;
    const updateData: Prisma.CallSessionUpdateInput = {
      ...rest,
      ...(metadata !== undefined && { metadata: metadata as Prisma.InputJsonValue }),
    };
    return this.prisma.callSession.update({
      where: { id: callSessionId },
      data: updateData,
    });
  }

  async updateSessionByTwilioCallSid(
    twilioCallSid: string,
    data: {
      status?: CallStatus;
      endedAt?: Date;
      durationSeconds?: number;
    },
  ) {
    return this.prisma.callSession.updateMany({
      where: { twilioCallSid },
      data,
    });
  }

  async findAllForTenant(tenantId: string) {
    return this.prisma.callSession.findMany({
      where: { tenantId },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneForTenant(tenantId: string, id: string) {
    return this.prisma.callSession.findFirstOrThrow({
      where: { id, tenantId },
      include: { transcripts: true, toolExecutions: true },
    });
  }

  /** Voice runtime / webhooks: load session by id without tenant header context. */
  async findOneById(id: string) {
    return this.prisma.callSession.findUniqueOrThrow({
      where: { id },
      include: { transcripts: true, toolExecutions: true },
    });
  }

  async findOneByTwilioCallSid(twilioCallSid: string) {
    return this.prisma.callSession.findFirst({
      where: { twilioCallSid },
    });
  }

  async mergeSessionMetadata(callSessionId: string, patch: Record<string, unknown>) {
    const existing = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const current =
      existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    return this.prisma.callSession.update({
      where: { id: callSessionId },
      data: { metadata: { ...current, ...patch } as Prisma.InputJsonValue },
    });
  }
}
