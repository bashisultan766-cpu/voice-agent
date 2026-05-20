import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CallbackRequestStatus, UserRole } from '@prisma/client';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CallbackRequestsService } from './callback-requests.service';
import {
  callbackListQuerySchema,
  callbackPatchStatusBodySchema,
} from './callback-requests-validation';
import { cuidParamSchema } from '../ops/ops-validation';
import type { z } from 'zod';

@Controller('calls/callback-requests')
@Roles(UserRole.MANAGER)
export class CallbackRequestsController {
  constructor(private readonly callbacks: CallbackRequestsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  list(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(callbackListQuerySchema)) query: z.infer<typeof callbackListQuerySchema>,
  ) {
    return this.callbacks.listForTenant(tenantId, {
      status: query.status,
      limit: query.limit,
    });
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id/status')
  updateStatus(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(callbackPatchStatusBodySchema))
    body: z.infer<typeof callbackPatchStatusBodySchema>,
  ) {
    const status = body.status ?? CallbackRequestStatus.IN_PROGRESS;
    return this.callbacks.updateStatus(tenantId, id, status);
  }
}
