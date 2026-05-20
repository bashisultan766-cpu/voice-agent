import { Module, forwardRef } from '@nestjs/common';
import { TwilioVoiceController } from './twilio.controller';
import { TwilioSignatureService } from './twilio-signature.service';
import { TwilioWebhookService } from './twilio-webhook.service';
import { TwilioStatusCallbackService } from './twilio-status-callback.service';
import { AgentResolutionService } from './agent-resolution.service';
import { TwilioSmsService } from './twilio-sms.service';
import { CallsModule } from '../../calls/calls.module';
import { AnalyticsModule } from '../../analytics/analytics.module';
import { ElevenLabsModule } from '../elevenlabs/elevenlabs.module';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { VoicePromptAudioService } from './voice-prompt-audio.service';

@Module({
  imports: [forwardRef(() => CallsModule), AnalyticsModule, ElevenLabsModule],
  controllers: [TwilioVoiceController],
  providers: [
    TwilioSignatureService,
    TwilioWebhookService,
    TwilioStatusCallbackService,
    TwilioSmsService,
    AgentResolutionService,
    TwilioTtsCacheService,
    VoicePromptAudioService,
  ],
  exports: [AgentResolutionService, TwilioSmsService],
})
export class TwilioModule {}
