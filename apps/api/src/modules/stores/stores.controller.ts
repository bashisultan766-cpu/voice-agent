import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { StoresService } from './stores.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { createStoreBodySchema, patchStoreBodySchema } from './stores-validation';
import { cuidParamSchema } from '../ops/ops-validation';
import type { z } from 'zod';

@Controller('stores')
@Roles(UserRole.MANAGER)
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  create(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(createStoreBodySchema)) body: z.infer<typeof createStoreBodySchema>,
  ) {
    return this.storesService.create({ tenantId, name: body.name, slug: body.slug });
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.storesService.findAll(tenantId);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id')
  update(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(patchStoreBodySchema)) body: z.infer<typeof patchStoreBodySchema>,
  ) {
    return this.storesService.updateForTenant(tenantId, id, body);
  }
}
