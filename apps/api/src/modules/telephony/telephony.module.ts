import { Module, forwardRef } from '@nestjs/common';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { ElevenLabsModule } from '../integrations/elevenlabs/elevenlabs.module';

/**
 * Twilio + ElevenLabs telephony entrypoints for realtime voice agents.
 * forwardRef: TwilioModule and ElevenLabsModule reference each other (webhook TTS).
 */
@Module({
  imports: [forwardRef(() => TwilioModule), forwardRef(() => ElevenLabsModule)],
  exports: [TwilioModule, ElevenLabsModule],
})
export class TelephonyModule {}
