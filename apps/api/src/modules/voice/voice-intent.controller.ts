import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import { VoiceIntentService } from './voice-intent.service';
import { VoiceFacilityLinkService } from './voice-facility-link.service';
import { flattenElevenLabsToolBody } from './utils/parse-elevenlabs-tool-body.util';
import {
  resolveCallSidFromToolBody,
  resolvePhoneNumberFromToolBody,
} from './utils/parse-elevenlabs-tool-body.util';

class NormalizeIntentDto {
  @IsString()
  @MaxLength(2000)
  transcript!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  callerPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  callSid?: string;
}

class FacilityPaymentLinkDto {
  @IsString()
  @MaxLength(64)
  orderNumber!: string;

  @IsString()
  @MaxLength(128)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string;
}

/**
 * SureShot Books voice intent normalization for ElevenLabs/Twilio transcripts.
 * POST /api/voice/normalize-intent
 * POST /api/voice/facility-payment-link
 */
@Controller('voice')
export class VoiceIntentController {
  constructor(
    private readonly voiceIntent: VoiceIntentService,
    private readonly facilityLink: VoiceFacilityLinkService,
  ) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('normalize-intent')
  normalizeIntent(@Body() body: NormalizeIntentDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const transcript =
      (typeof flat.transcript === 'string' && flat.transcript) ||
      (typeof flat.text === 'string' && flat.text) ||
      (typeof flat.speech === 'string' && flat.speech) ||
      (typeof body.transcript === 'string' && body.transcript) ||
      '';

    if (!transcript.trim()) {
      throw new BadRequestException('transcript is required (or text/speech in tool body).');
    }

    const callerPhone =
      resolvePhoneNumberFromToolBody(body) ||
      (typeof flat.callerPhone === 'string' ? flat.callerPhone : undefined) ||
      body.callerPhone;
    const callSid = resolveCallSidFromToolBody(body) || body.callSid;

    return this.voiceIntent.normalizeIntent({
      transcript,
      callerPhone: typeof callerPhone === 'string' ? callerPhone : undefined,
      callSid: typeof callSid === 'string' ? callSid : undefined,
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('facility-payment-link')
  async facilityPaymentLink(@Body() body: FacilityPaymentLinkDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const orderNumber =
      (typeof flat.orderNumber === 'string' && flat.orderNumber) ||
      (typeof flat.order_number === 'string' && flat.order_number) ||
      body.orderNumber;
    const email = (typeof flat.email === 'string' && flat.email) || body.email;
    const tenantId =
      (typeof flat.tenantId === 'string' && flat.tenantId) ||
      (typeof flat.tenant_id === 'string' && flat.tenant_id) ||
      body.tenantId;
    const agentId =
      (typeof flat.agentId === 'string' && flat.agentId) ||
      (typeof flat.agent_id === 'string' && flat.agent_id) ||
      body.agentId;

    if (!orderNumber?.trim() || !email?.trim()) {
      throw new BadRequestException('orderNumber and email are required.');
    }

    const result = await this.facilityLink.sendFacilityPaymentLink({
      orderNumber: orderNumber.trim(),
      email: email.trim(),
      tenantId: typeof tenantId === 'string' ? tenantId : '',
      agentId: typeof agentId === 'string' ? agentId : '',
    });

    if (!result.success) {
      this.voiceIntent.logAgentToolFailure(
        'facility_payment_link',
        result.error ?? 'Facility link send failed.',
      );
    }

    return {
      success: result.success,
      emailSent: result.emailSent ?? false,
      message: result.success
        ? 'Secure facility payment link sent to the provided email.'
        : result.error ?? 'Could not send facility payment link.',
    };
  }
}
