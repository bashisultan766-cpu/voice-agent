import { Module, forwardRef } from '@nestjs/common';
import { VoiceResponseControllerService } from './voice-response-controller.service';
import { VoiceTtsGatewayService } from './voice-tts-gateway.service';
import { VoiceOptimizationController } from './voice-optimization.controller';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { CallsModule } from '../calls/calls.module';

@Module({
  imports: [forwardRef(() => TwilioModule), forwardRef(() => CallsModule)],
  controllers: [VoiceOptimizationController],
  providers: [VoiceResponseControllerService, VoiceTtsGatewayService],
  exports: [VoiceResponseControllerService, VoiceTtsGatewayService],
})
export class VoiceOptimizationModule {}
