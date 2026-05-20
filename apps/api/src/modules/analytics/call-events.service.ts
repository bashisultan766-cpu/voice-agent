import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CallEventType, Prisma } from '@prisma/client';

@Injectable()
export class CallEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    tenantId: string,
    callSessionId: string,
    type: CallEventType,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.callEvent.create({
      data: {
        tenantId,
        callSessionId,
        type,
        payload: payload !== undefined ? (payload as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async getByCallSession(callSessionId: string, tenantId?: string) {
    return this.prisma.callEvent.findMany({
      where: {
        callSessionId,
        ...(tenantId && { tenantId }),
      },
      orderBy: { timestamp: 'asc' },
    });
  }
}
