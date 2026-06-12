import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { ThreeCxCallerService } from '../integrations/caller-identity/three-cx-caller.service';
import { InboundCallCaptureService } from '../delivery/inbound-call-capture.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import {
  flattenElevenLabsToolBody,
  resolveCallSidFromToolBody,
  resolvePhoneNumberFromToolBody,
} from './utils/parse-elevenlabs-tool-body.util';

/**
 * ElevenLabs server tool — live 3CX caller lookup + call history.
 * GET  /api/voice/get-caller-info?phone_number=...
 * POST /api/voice/get-caller-info  (GetCallerInfo tool)
 */
@Controller('voice')
export class VoiceGetCallerInfoController {
  constructor(
    private readonly threeCxCaller: ThreeCxCallerService,
    private readonly inboundCalls: InboundCallCaptureService,
  ) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Get('get-caller-info')
  async getCallerInfoGet(@Query('phone_number') phoneNumber?: string) {
    const phone = (phoneNumber ?? '').trim();
    if (!phone) {
      throw new BadRequestException('phone_number query parameter is required.');
    }
    return this.threeCxCaller.getCallerInfo(phone);
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('get-caller-info')
  async getCallerInfoPost(@Body() body: Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const callSid = resolveCallSidFromToolBody(body);
    let phone =
      pickString(flat, ['phone_number', 'phoneNumber', 'phone', 'caller_phone']) ||
      resolvePhoneNumberFromToolBody(body);

    if (!phone && callSid) {
      phone = (await this.inboundCalls.findCallerPhoneByCallSid(callSid)) ?? undefined;
    }

    if (!phone) {
      throw new BadRequestException(
        'phone_number is required (or callSid with a known inbound call). Use {{caller_phone}} in the ElevenLabs tool.',
      );
    }

    return this.threeCxCaller.getCallerInfo(phone, { excludeCallSid: callSid });
  }
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
