import { Controller, ForbiddenException, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { TenantsService } from './tenants.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { cuidParamSchema } from '../ops/ops-validation';

@Controller('tenants')
@Roles(UserRole.MANAGER)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  /** Current workspace only (id must match authenticated tenant). */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':id')
  findOne(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    if (id !== tenantId) throw new ForbiddenException();
    return this.tenantsService.findOne(id);
  }
}
