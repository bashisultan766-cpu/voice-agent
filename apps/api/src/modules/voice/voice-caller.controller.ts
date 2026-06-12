import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { CallerIdentityService } from '../integrations/caller-identity/caller-identity.service';
import { ThreeCxCallerService } from '../integrations/caller-identity/three-cx-caller.service';
import { InboundCallCaptureService } from '../delivery/inbound-call-capture.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import {
  flattenElevenLabsToolBody,
  resolveCallSidFromToolBody,
  resolvePhoneNumberFromToolBody,
} from './utils/parse-elevenlabs-tool-body.util';

/**
 * ElevenLabs server tool — save caller name when not in 3CX directory.
 * POST /api/voice/save-caller-name
 */
@Controller('voice')
export class VoiceCallerController {
  constructor(
    private readonly callerIdentity: CallerIdentityService,
    private readonly threeCxCaller: ThreeCxCallerService,
    private readonly inboundCalls: InboundCallCaptureService,
  ) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('save-caller-name')
  async saveCallerName(@Body() body: Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const name = pickString(flat, ['name', 'callerName', 'customerName', 'displayName']);
    if (!name) {
      throw new BadRequestException('name is required.');
    }

    const callSid = resolveCallSidFromToolBody(body);
    let phone =
      resolvePhoneNumberFromToolBody(body) ||
      pickString(flat, ['phone', 'phoneNumber', 'caller_phone']);

    if (!phone && callSid) {
      phone = (await this.inboundCalls.findCallerPhoneByCallSid(callSid)) ?? undefined;
    }

    if (!phone) {
      throw new BadRequestException('phoneNumber or callSid with a known inbound call is required.');
    }

    const saved = await this.callerIdentity.saveCallerName({
      phone,
      name,
      email: pickString(flat, ['email', 'customerEmail']),
      callSid,
    });

    const threeCx = await this.threeCxCaller.saveCallerToThreeCx({
      phone,
      name,
      email: pickString(flat, ['email', 'customerEmail']),
    });

    return {
      ...saved,
      saved_to_three_cx: threeCx.savedToThreeCx,
      three_cx_contact_id: threeCx.contactId,
    };
  }
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
