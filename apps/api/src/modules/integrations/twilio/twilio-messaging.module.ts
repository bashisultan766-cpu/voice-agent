import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TwilioSmsService } from './twilio-sms.service';

/**
 * SMS/WhatsApp REST only — no CallsModule or ElevenLabsModule.
 *
 * Imported by DeliveryModule so payment-link SMS does not pull in the full
 * Twilio voice webhook graph (which created AppModule → … → DeliveryModule → TwilioModule cycle).
 */
@Module({
  imports: [ConfigModule],
  providers: [TwilioSmsService],
  exports: [TwilioSmsService],
})
export class TwilioMessagingModule {}
