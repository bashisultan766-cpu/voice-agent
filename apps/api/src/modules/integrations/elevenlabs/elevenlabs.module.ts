import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InboundCallModule } from '../../delivery/inbound-call.module';
import { CallerIdentityModule } from '../caller-identity/caller-identity.module';
import { ElevenLabsService } from './elevenlabs.service';
import { ElevenLabsStreamingService } from './elevenlabs-streaming.service';
import { ElevenLabsController } from './elevenlabs.controller';
import { ElevenLabsTwilioController } from './elevenlabs-twilio.controller';
import { ElevenLabsConvaiController } from './elevenlabs-convai.controller';
import { ElevenLabsTwilioRegisterCallService } from './elevenlabs-twilio-register-call.service';

/**
 * ElevenLabs TTS + ConvAI Twilio register-call bridge.
 *
 * Uses InboundCallModule only (not DeliveryModule) so TwilioModule can import this module
 * without closing a loop: DeliveryModule → TwilioModule → ElevenLabsModule → DeliveryModule.
 */
@Module({
  imports: [ConfigModule, InboundCallModule, CallerIdentityModule],
  controllers: [ElevenLabsController, ElevenLabsTwilioController, ElevenLabsConvaiController],
  providers: [ElevenLabsService, ElevenLabsStreamingService, ElevenLabsTwilioRegisterCallService],
  exports: [ElevenLabsService, ElevenLabsStreamingService, ElevenLabsTwilioRegisterCallService],
})
export class ElevenLabsModule {}
