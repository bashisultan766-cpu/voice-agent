import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../../database/prisma.module';
import { TwilioVoiceController } from './twilio.controller';
import { TwilioSignatureService } from './twilio-signature.service';
import { TwilioAuthTokenResolverService } from './twilio-auth-token-resolver.service';
import { TwilioWebhookService } from './twilio-webhook.service';
import { TwilioStatusCallbackService } from './twilio-status-callback.service';
import { AgentResolutionService } from './agent-resolution.service';
import { CallsModule } from '../../calls/calls.module';
import { AnalyticsModule } from '../../analytics/analytics.module';
import { ElevenLabsModule } from '../elevenlabs/elevenlabs.module';
import { AgentsModule } from '../../agents/agents.module';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { VoicePromptAudioService } from './voice-prompt-audio.service';
import { VoiceAudioCacheService } from './voice-audio-cache.service';
import { TwilioMediaStreamService } from './twilio-media-stream.service';
import { TwilioMessagingModule } from './twilio-messaging.module';
import { VoiceDiagnosticsModule } from '../../voice/voice-diagnostics.module';
import { VoiceOptimizationModule } from '../../voice-optimization/voice-optimization.module';

/**
 * Twilio voice webhooks + media stream.
 *
 * Circular deps with CallsModule (runtime session) and ElevenLabsModule (TTS) use forwardRef.
 * SMS lives in TwilioMessagingModule so DeliveryModule never imports this heavy module.
 */
@Module({
  imports: [
    PrismaModule,
    TwilioMessagingModule,
    VoiceDiagnosticsModule,
    forwardRef(() => CallsModule),
    forwardRef(() => VoiceOptimizationModule),
    AnalyticsModule,
    forwardRef(() => ElevenLabsModule),
    AgentsModule,
  ],
  controllers: [TwilioVoiceController],
  providers: [
    TwilioAuthTokenResolverService,
    TwilioSignatureService,
    TwilioWebhookService,
    TwilioStatusCallbackService,
    AgentResolutionService,
    TwilioTtsCacheService,
    VoiceAudioCacheService,
    VoicePromptAudioService,
    TwilioMediaStreamService,
  ],
  exports: [
    AgentResolutionService,
    TwilioMessagingModule,
    VoicePromptAudioService,
    VoiceAudioCacheService,
    TwilioTtsCacheService,
  ],
})
export class TwilioModule {}
