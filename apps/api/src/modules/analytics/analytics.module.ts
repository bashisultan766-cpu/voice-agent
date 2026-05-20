import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { CallEventsService } from './call-events.service';
import { CallOutcomeService } from './call-outcome.service';
import { QaReviewService } from './qa-review.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, CallEventsService, CallOutcomeService, QaReviewService],
  exports: [CallEventsService, CallOutcomeService, QaReviewService],
})
export class AnalyticsModule {}
