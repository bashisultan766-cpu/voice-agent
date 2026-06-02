import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SendPaymentLinkDto } from './dto/send-payment-link.dto';
import { VoicePaymentService } from './voice-payment.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import { resolveSendPaymentLinkFieldsFromToolBody } from './utils/parse-elevenlabs-tool-body.util';

/**
 * Voice checkout — draft order invoice for ElevenLabs server tools.
 * POST /api/voice/send-payment-link
 *
 * Accepts flat JSON or ElevenLabs `{ parameters: { ... } }` tool payloads.
 */
@Controller('voice')
export class VoicePaymentController {
  constructor(private readonly voicePayment: VoicePaymentService) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('send-payment-link')
  sendPaymentLink(@Body() body: SendPaymentLinkDto & Record<string, unknown>) {
    const fromTool = resolveSendPaymentLinkFieldsFromToolBody(body);

    const email = (fromTool.email ?? body.email)?.trim();
    const variantId = (fromTool.variantId ?? body.variantId)?.trim();
    const quantity = fromTool.quantity ?? body.quantity;
    const phoneNumber =
      fromTool.phoneNumber?.trim() || body.phoneNumber?.trim() || body.phone?.trim();
    const callSid =
      fromTool.callSid?.trim() || body.callSid?.trim() || body.call_sid?.trim();

    if (!variantId || quantity == null) {
      throw new BadRequestException('variantId and quantity are required.');
    }
    if (!email && !callSid) {
      throw new BadRequestException(
        'email is required, or callSid with a confirmed session email.',
      );
    }

    const emailConfirmed =
      fromTool.emailConfirmed ?? this.resolveEmailConfirmed(body.emailConfirmed, body);

    return this.voicePayment.sendPaymentLink({
      email: email ?? '',
      variantId,
      quantity,
      phoneNumber,
      callSid,
      tenantId: fromTool.tenantId ?? body.tenantId,
      agentId: fromTool.agentId ?? body.agentId,
      emailConfirmed,
    });
  }

  private resolveEmailConfirmed(
    value: unknown,
    body: Record<string, unknown>,
  ): boolean | undefined {
    const direct = this.coerceBoolean(value);
    if (direct !== undefined) return direct;
    const typo = this.coerceBoolean(body.emailComfirmed ?? body.email_confirmed ?? body.email_comfirmed);
    return typo;
  }

  private coerceBoolean(value: unknown): boolean | undefined {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
      if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    }
    if (typeof value === 'number') {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    return undefined;
  }
}
