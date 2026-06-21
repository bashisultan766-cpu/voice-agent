import { Module, forwardRef } from '@nestjs/common';
import { RawInputCaptureService } from './raw-input-capture.service';
import { IntentAnalysisService } from './intent-analysis.service';
import { ResponseOrchestratorService } from './response-orchestrator.service';
import { VoiceIntentPipelineService } from './voice-intent-pipeline.service';
import { AIOrchestratorService } from './ai-orchestrator.service';
import { EscalationQueueService } from './escalation-queue.service';
import { VoiceResponseCacheService } from './voice-response-cache.service';
import { VoiceCallCenterController } from './voice-call-center.controller';
import { CallsModule } from '../calls/calls.module';
import { VoiceModule } from '../voice/voice.module';

@Module({
  imports: [forwardRef(() => CallsModule), VoiceModule],
  controllers: [VoiceCallCenterController],
  providers: [
    RawInputCaptureService,
    IntentAnalysisService,
    ResponseOrchestratorService,
    VoiceIntentPipelineService,
    AIOrchestratorService,
    EscalationQueueService,
    VoiceResponseCacheService,
  ],
  exports: [
    VoiceIntentPipelineService,
    RawInputCaptureService,
    IntentAnalysisService,
    ResponseOrchestratorService,
    AIOrchestratorService,
    EscalationQueueService,
  ],
})
export class VoiceIntentPipelineModule {}
