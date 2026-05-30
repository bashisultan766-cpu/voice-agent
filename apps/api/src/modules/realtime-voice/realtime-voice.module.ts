import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { RealtimeVoiceController } from './realtime-voice.controller';
import { RealtimeVoiceOrchestratorService } from './orchestrator/realtime-voice-orchestrator.service';
import { VoiceEventBusService } from './events/voice-event-bus.service';
import { VoiceSessionMemoryService } from './memory/voice-session-memory.service';
import { VoiceLongTermMemoryService } from './memory/voice-long-term-memory.service';
import { RouterAgent } from './agents/router.agent';
import { ConversationAgent } from './agents/conversation.agent';
import { ShopifySearchAgent } from './agents/shopify-search.agent';
import { IsbnSearchAgent } from './agents/isbn-search.agent';
import { EmailVerificationAgent } from './agents/email-verification.agent';
import { PaymentLinkAgent } from './agents/payment-link.agent';
import { MemoryAgent } from './agents/memory.agent';
import { VoiceStreamingAgent } from './agents/voice-streaming.agent';
import { BackgroundTaskAgent } from './agents/background-task.agent';
import { AnalyticsAgent } from './agents/analytics.agent';
import { VoiceTaskQueueService } from './workers/voice-task.queue';
import { RealtimeVoiceGateway } from './websocket/realtime-voice.gateway';
import { OpenAiRealtimeService } from './streaming/openai-realtime.service';
import { LegacyVoiceBridgeService } from './bridge/legacy-voice-bridge.service';
import { CallsModule } from '../calls/calls.module';
import { AgentsModule } from '../agents/agents.module';
import { BookstoreSearchModule } from '../search/bookstore-search.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { EmailModule } from '../integrations/email/email.module';
import { ElevenLabsModule } from '../integrations/elevenlabs/elevenlabs.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { RealtimeMediaStreamGateway } from './media-stream/realtime-media-stream.gateway';
import { FullDuplexPipelineService } from './media-stream/full-duplex-pipeline.service';
import { OpenAiRealtimeBridgeService } from './media-stream/openai-realtime-bridge.service';
import { RealtimeVoiceMetricsService } from './media-stream/realtime-voice-metrics.service';
import { MediaStreamFallbackService } from './media-stream/media-stream-fallback.service';
import { VoiceCheckoutFlowService } from './checkout/voice-checkout-flow.service';
import { VoiceE2ETraceService } from './observability/voice-e2e-trace.service';
import { VoiceE2EObservabilityListener } from './observability/voice-e2e-observability.listener';

@Module({
  imports: [
    forwardRef(() => CallsModule),
    PrismaModule,
    AgentsModule,
    BookstoreSearchModule,
    ShopifyModule,
    EmailModule,
    ElevenLabsModule,
    AnalyticsModule,
  ],
  controllers: [RealtimeVoiceController],
  providers: [
    RealtimeVoiceOrchestratorService,
    VoiceEventBusService,
    VoiceSessionMemoryService,
    VoiceLongTermMemoryService,
    RouterAgent,
    ConversationAgent,
    ShopifySearchAgent,
    IsbnSearchAgent,
    EmailVerificationAgent,
    PaymentLinkAgent,
    MemoryAgent,
    VoiceStreamingAgent,
    BackgroundTaskAgent,
    AnalyticsAgent,
    VoiceTaskQueueService,
    RealtimeVoiceGateway,
    OpenAiRealtimeService,
    LegacyVoiceBridgeService,
    RealtimeMediaStreamGateway,
    FullDuplexPipelineService,
    OpenAiRealtimeBridgeService,
    RealtimeVoiceMetricsService,
    MediaStreamFallbackService,
    VoiceCheckoutFlowService,
    VoiceE2ETraceService,
    VoiceE2EObservabilityListener,
  ],
  exports: [
    RealtimeVoiceOrchestratorService,
    LegacyVoiceBridgeService,
    RealtimeVoiceGateway,
    RealtimeMediaStreamGateway,
    FullDuplexPipelineService,
    VoiceE2ETraceService,
  ],
})
export class RealtimeVoiceModule {}
