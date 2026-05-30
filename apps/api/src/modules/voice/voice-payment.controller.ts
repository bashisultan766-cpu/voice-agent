import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SendPaymentLinkDto } from './dto/send-payment-link.dto';
import { VoicePaymentService } from './voice-payment.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';

/**
 * Voice checkout — draft order invoice for ElevenLabs server tools.
 * POST /api/voice/send-payment-link
 */
@Controller('voice')
export class VoicePaymentController {
  constructor(private readonly voicePayment: VoicePaymentService) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('send-payment-link')
  sendPaymentLink(@Body() dto: SendPaymentLinkDto) {
    return this.voicePayment.sendPaymentLink({
      email: dto.email,
      variantId: dto.variantId,
      quantity: dto.quantity,
      tenantId: dto.tenantId,
      agentId: dto.agentId,
    });
  }
}
