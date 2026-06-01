import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { InboundCallCaptureService } from './inbound-call-capture.service';

/**
 * Persists Twilio inbound caller metadata (`calls` table).
 *
 * Kept separate from DeliveryModule so ElevenLabsModule can capture CallSid/From/To
 * without importing DeliveryModule (and without importing TwilioModule).
 */
@Module({
  imports: [PrismaModule],
  providers: [InboundCallCaptureService],
  exports: [InboundCallCaptureService],
})
export class InboundCallModule {}
