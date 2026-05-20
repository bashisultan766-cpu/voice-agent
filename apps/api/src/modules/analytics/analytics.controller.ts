import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { CallEventsService } from './call-events.service';
import { CallOutcomeService } from './call-outcome.service';
import { QaReviewService } from './qa-review.service';
import { UpdateCallOutcomeDto } from './dto/update-call-outcome.dto';
import { CreateQaReviewDto } from './dto/create-qa-review.dto';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  analyticsFilterQuerySchema,
  qaCallsListQuerySchema,
  type AnalyticsFilterQuery,
} from './analytics-query.schema';
import { cuidParamSchema } from '../ops/ops-validation';
import type { z } from 'zod';

@Controller()
@Roles(UserRole.MANAGER)
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly callEvents: CallEventsService,
    private readonly callOutcome: CallOutcomeService,
    private readonly qaReview: QaReviewService,
  ) {}

  private parseDates(query: AnalyticsFilterQuery): { from?: Date; to?: Date } {
    return {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    };
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('analytics/overview')
  getOverview(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(analyticsFilterQuerySchema)) query: z.infer<typeof analyticsFilterQuerySchema>,
  ) {
    const { from, to } = this.parseDates(query);
    return this.analytics.getOverview(tenantId, from, to);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('analytics/agents')
  getAgentMetrics(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(analyticsFilterQuerySchema)) query: z.infer<typeof analyticsFilterQuerySchema>,
  ) {
    const { from, to } = this.parseDates(query);
    return this.analytics.getAgentMetrics(tenantId, from, to);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('analytics/stores')
  getStoreMetrics(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(analyticsFilterQuerySchema)) query: z.infer<typeof analyticsFilterQuerySchema>,
  ) {
    const { from, to } = this.parseDates(query);
    return this.analytics.getStoreMetrics(tenantId, from, to);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('analytics/tools')
  getToolMetrics(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(analyticsFilterQuerySchema)) query: z.infer<typeof analyticsFilterQuerySchema>,
  ) {
    const { from, to } = this.parseDates(query);
    return this.analytics.getToolMetrics(tenantId, from, to);
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('calls/:id/events')
  getCallEvents(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    return this.callEvents.getByCallSession(id, tenantId);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch('calls/:id/outcome')
  updateCallOutcome(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body() body: UpdateCallOutcomeDto,
  ) {
    return this.callOutcome.update(tenantId, id, body);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('qa/calls')
  listQaCalls(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(qaCallsListQuerySchema)) query: z.infer<typeof qaCallsListQuerySchema>,
  ) {
    return this.qaReview.listCallsForQa(tenantId, {
      limit: query.limit,
      hasOutcome:
        query.hasOutcome === 'true' ? true : query.hasOutcome === 'false' ? false : undefined,
    });
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('qa/calls/:id')
  getQaCallDetail(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    return this.qaReview.getQaDetail(id, tenantId);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('qa/calls/:id/review')
  submitQaReview(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body() body: CreateQaReviewDto,
  ) {
    return this.qaReview.submitReview(tenantId, id, body);
  }
}
