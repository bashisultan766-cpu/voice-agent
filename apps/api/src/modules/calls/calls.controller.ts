import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CallsService } from './calls.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { cuidParamSchema } from '../ops/ops-validation';

@Controller('calls')
@Roles(UserRole.MANAGER)
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.callsService.findAllForTenant(tenantId);
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get(':id')
  findOne(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    return this.callsService.findOneForTenant(tenantId, id);
  }
}
