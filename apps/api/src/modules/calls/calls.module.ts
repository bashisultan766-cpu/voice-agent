import { Module, forwardRef } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { VoiceRuntimeController } from './runtime/voice-runtime.controller';
import { VoiceConfigCheckController } from './runtime/voice-config-check.controller';
import { VoiceConfigCheckService } from './runtime/voice-config-check.service';
import { VoiceRuntimeService } from './runtime/voice-runtime.service';
import { LlmAgentOrchestratorService } from './runtime/llm-agent-orchestrator.service';
import { TranscriptNormalizerService } from './runtime/transcript-normalizer.service';
import { SessionContextService } from './runtime/session-context.service';
import { TranscriptBufferService } from './runtime/transcript-buffer.service';
import { ToolOrchestratorService } from './runtime/tool-orchestrator.service';
import { VoiceRuntimeContextService } from './runtime/voice-runtime-context.service';
import { RuntimeSafetyService } from './runtime/runtime-safety.service';
import { CallMemoryService } from './runtime/call-memory.service';
import { ConversationFlowEngineService } from './runtime/conversation-flow-engine.service';
import { ConversationAnalyticsService } from './runtime/conversation-analytics.service';
import { PolicyContextPrefetchService } from './runtime/policy-context-prefetch.service';
import { VoiceStreamMetricsService } from './runtime/voice-stream-metrics.service';
import { VoiceCostAnalyticsService } from './runtime/voice-cost-analytics.service';
import { VoiceStreamingSessionService } from './runtime/voice-streaming-session.service';
import { VoiceLiveMonitorService } from './runtime/voice-live-monitor.service';
import { VoiceLatencyAnalyzerService } from './runtime/voice-latency-analyzer.service';
import { VoiceProductFastPathService } from './runtime/voice-product-fast-path.service';
import { OpenAIModule } from '../integrations/openai/openai.module';
import { OpenAIVoiceService } from '../integrations/openai/openai-voice.service';
import { OpenAIStreamingVoiceService } from '../integrations/openai/openai-streaming-voice.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AgentsModule } from '../agents/agents.module';
import { CallbackRequestsService } from './callback-requests.service';
import { CallbackRequestsController } from './callback-requests.controller';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { EmailModule } from '../integrations/email/email.module';
import { ToolsModule } from '../tools/tools.module';
import { RealtimeVoiceModule } from '../realtime-voice/realtime-voice.module';

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
    forwardRef(() => RealtimeVoiceModule),
  ],
  controllers: [CallsController, VoiceRuntimeController, VoiceConfigCheckController, CallbackRequestsController],
  providers: [
    CallsService,
    VoiceRuntimeService,
    LlmAgentOrchestratorService,
    TranscriptNormalizerService,
    VoiceConfigCheckService,
    SessionContextService,
    TranscriptBufferService,
    ToolOrchestratorService,
    VoiceRuntimeContextService,
    RuntimeSafetyService,
    CallMemoryService,
    ConversationFlowEngineService,
    ConversationAnalyticsService,
    PolicyContextPrefetchService,
    VoiceStreamMetricsService,
    VoiceCostAnalyticsService,
    VoiceStreamingSessionService,
    VoiceLiveMonitorService,
    VoiceLatencyAnalyzerService,
    VoiceProductFastPathService,
    OpenAIVoiceService,
    OpenAIStreamingVoiceService,
    CallbackRequestsService,
  ],
  exports: [
    CallsService,
    SessionContextService,
    VoiceRuntimeService,
    LlmAgentOrchestratorService,
    CallbackRequestsService,
    TranscriptBufferService,
    ToolOrchestratorService,
    VoiceStreamMetricsService,
    VoiceCostAnalyticsService,
    VoiceStreamingSessionService,
    VoiceLiveMonitorService,
    VoiceLatencyAnalyzerService,
  ],
})
export class CallsModule {}
