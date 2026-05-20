import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import type { z } from 'zod';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { OpsService } from './ops.service';
import {
  cuidParamSchema,
  fullReadinessSmokeBodySchema,
  simulateBuyingFlowBodySchema,
  simulateToolBodySchema,
  testEmailBodySchema,
} from './ops-validation';

@Controller('ops')
@Roles(UserRole.SUPPORT)
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('agents')
  getAgents(@TenantId() tenantId: string) {
    return this.ops.getAgentsOverview(tenantId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('calls')
  getCalls(@TenantId() tenantId: string) {
    return this.ops.getCalls(tenantId);
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('calls/:callSessionId/transcripts')
  getTranscripts(
    @TenantId() tenantId: string,
    @Param('callSessionId', new ZodValidationPipe(cuidParamSchema)) callSessionId: string,
  ) {
    return this.ops.getTranscripts(tenantId, callSessionId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('checkout-links')
  getCheckoutLinks(@TenantId() tenantId: string) {
    return this.ops.getCheckoutLinks(tenantId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('leads')
  getLeads(@TenantId() tenantId: string) {
    return this.ops.getLeads(tenantId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('email-events')
  getEmailEvents(@TenantId() tenantId: string) {
    return this.ops.getEmailEvents(tenantId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('payments')
  getPayments(@TenantId() tenantId: string) {
    return this.ops.getPayments(tenantId);
  }

  @Post('agents/:agentId/simulate-tool')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  simulateTool(
    @TenantId() tenantId: string,
    @Param('agentId', new ZodValidationPipe(cuidParamSchema)) agentId: string,
    @Body(new ZodValidationPipe(simulateToolBodySchema))
    body: z.infer<typeof simulateToolBodySchema>,
  ) {
    return this.ops.simulateToolCall(tenantId, agentId, body);
  }

  @Post('agents/:agentId/sync-products')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  syncProducts(
    @TenantId() tenantId: string,
    @Param('agentId', new ZodValidationPipe(cuidParamSchema)) agentId: string,
  ) {
    return this.ops.syncProductsManual(tenantId, agentId);
  }

  @Post('agents/:agentId/test-email')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  sendTestEmail(
    @TenantId() tenantId: string,
    @Param('agentId', new ZodValidationPipe(cuidParamSchema)) agentId: string,
    @Body(new ZodValidationPipe(testEmailBodySchema))
    body: z.infer<typeof testEmailBodySchema>,
  ) {
    return this.ops.sendDevelopmentTestEmail(tenantId, agentId, body);
  }

  @Post('agents/:agentId/simulate-buying-flow')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  simulateBuyingFlow(
    @TenantId() tenantId: string,
    @Param('agentId', new ZodValidationPipe(cuidParamSchema)) agentId: string,
    @Body(new ZodValidationPipe(simulateBuyingFlowBodySchema))
    body: z.infer<typeof simulateBuyingFlowBodySchema>,
  ) {
    return this.ops.simulateBuyingFlow(tenantId, agentId, body);
  }

  @Post('agents/:agentId/full-readiness-smoke')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  fullReadinessSmoke(
    @TenantId() tenantId: string,
    @Param('agentId', new ZodValidationPipe(cuidParamSchema)) agentId: string,
    @Body(new ZodValidationPipe(fullReadinessSmokeBodySchema))
    body: z.infer<typeof fullReadinessSmokeBodySchema>,
  ) {
    return this.ops.fullReadinessSmoke(tenantId, agentId, body);
  }
}
