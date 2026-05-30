import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ElevenLabsService } from './elevenlabs.service';
import { ElevenLabsStreamingService } from './elevenlabs-streaming.service';
import { ElevenLabsController } from './elevenlabs.controller';
import { ElevenLabsTwilioController } from './elevenlabs-twilio.controller';
import { ElevenLabsTwilioRegisterCallService } from './elevenlabs-twilio-register-call.service';

@Module({
  imports: [ConfigModule],
  controllers: [ElevenLabsController, ElevenLabsTwilioController],
  providers: [ElevenLabsService, ElevenLabsStreamingService, ElevenLabsTwilioRegisterCallService],
  exports: [ElevenLabsService, ElevenLabsStreamingService, ElevenLabsTwilioRegisterCallService],
})
export class ElevenLabsModule {}
