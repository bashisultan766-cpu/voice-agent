import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { VoiceConfigCheckService } from './voice-config-check.service';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('voice')
@Roles(UserRole.MANAGER)
export class VoiceConfigCheckController {
  constructor(private readonly checkSvc: VoiceConfigCheckService) {}

  /**
   * Diagnostic: which credential sources apply for an agent (no secrets returned).
   * GET /api/voice/config-check?agentId=...
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('config-check')
  async configCheck(@TenantId() tenantId: string, @Query('agentId') agentIdRaw?: string) {
    const agentId = agentIdRaw?.trim();
    if (!agentId) {
      return {
        error: 'agentId_required',
        message: 'Pass agentId as a query parameter.',
      };
    }
    return this.checkSvc.check(tenantId, agentId);
  }
}
