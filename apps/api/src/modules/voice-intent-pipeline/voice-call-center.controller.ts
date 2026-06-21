import { Controller, Get, Param, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { EscalationQueueService } from './escalation-queue.service';

@Controller('voice-call-center')
@Roles(UserRole.MANAGER)
export class VoiceCallCenterController {
  constructor(private readonly escalationQueue: EscalationQueueService) {}

  @Get('escalations/:tenantId')
  async listEscalations(
    @Param('tenantId') tenantId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : 50;
    const entries = await this.escalationQueue.getPendingForTenant(
      tenantId,
      Number.isFinite(parsedLimit) ? parsedLimit : 50,
    );
    return { count: entries.length, entries };
  }
}
