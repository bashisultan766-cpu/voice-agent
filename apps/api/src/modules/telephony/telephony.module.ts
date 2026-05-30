import { Module } from '@nestjs/common';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { ElevenLabsModule } from '../integrations/elevenlabs/elevenlabs.module';

/**
 * Twilio + ElevenLabs telephony entrypoints for realtime voice agents.
 */
@Module({
  imports: [TwilioModule, ElevenLabsModule],
  exports: [TwilioModule, ElevenLabsModule],
})
export class TelephonyModule {}
