import { Module, forwardRef } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { VoiceRuntimeController } from './runtime/voice-runtime.controller';
import { VoiceConfigCheckController } from './runtime/voice-config-check.controller';
import { VoiceConfigCheckService } from './runtime/voice-config-check.service';
import { VoiceRuntimeService } from './runtime/voice-runtime.service';
import { SessionContextService } from './runtime/session-context.service';
import { TranscriptBufferService } from './runtime/transcript-buffer.service';
import { ToolOrchestratorService } from './runtime/tool-orchestrator.service';
import { VoiceRuntimeContextService } from './runtime/voice-runtime-context.service';
import { RuntimeSafetyService } from './runtime/runtime-safety.service';
import { CallMemoryService } from './runtime/call-memory.service';
import { OpenAIModule } from '../integrations/openai/openai.module';
import { OpenAIVoiceService } from '../integrations/openai/openai-voice.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AgentsModule } from '../agents/agents.module';
import { CallbackRequestsService } from './callback-requests.service';
import { CallbackRequestsController } from './callback-requests.controller';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { EmailModule } from '../integrations/email/email.module';
import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [
    ToolsModule,
    OpenAIModule,
    KnowledgeModule,
    AnalyticsModule,
    AgentsModule,
    ShopifyModule,
    EmailModule,
    forwardRef(() => TwilioModule),
  ],
  controllers: [CallsController, VoiceRuntimeController, VoiceConfigCheckController, CallbackRequestsController],
  providers: [
    CallsService,
    VoiceRuntimeService,
    VoiceConfigCheckService,
    SessionContextService,
    TranscriptBufferService,
    ToolOrchestratorService,
    VoiceRuntimeContextService,
    RuntimeSafetyService,
    CallMemoryService,
    OpenAIVoiceService,
    CallbackRequestsService,
  ],
  exports: [
    CallsService,
    SessionContextService,
    VoiceRuntimeService,
    CallbackRequestsService,
    TranscriptBufferService,
    ToolOrchestratorService,
  ],
})
export class CallsModule {}
