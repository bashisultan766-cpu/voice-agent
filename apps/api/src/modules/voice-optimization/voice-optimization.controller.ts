import { Body, Controller, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { VoiceResponseControllerService } from './voice-response-controller.service';
import { VoiceTtsGatewayService } from './voice-tts-gateway.service';
import { compressForVoice } from './voice-text-compressor.util';
import type { VoiceControlledResponse } from './types/voice-controlled-response.types';

class CompressVoiceTextDto {
  text!: string;
}

class BuildVoiceResponseDto {
  text!: string;
  action?: string;
  userIntent?: string;
}

/**
 * Internal ops routes for voice optimization (JWT + manager role).
 * Twilio live calls use services directly — not these HTTP endpoints.
 */
@Controller('voice-optimization')
@Roles(UserRole.MANAGER)
export class VoiceOptimizationController {
  constructor(
    private readonly responseController: VoiceResponseControllerService,
    private readonly ttsGateway: VoiceTtsGatewayService,
  ) {}

  @Post('compress')
  compress(@Body() body: CompressVoiceTextDto): { voice_text: string; original_chars: number; voice_chars: number } {
    const original = body.text?.trim() ?? '';
    const voice_text = compressForVoice(original);
    return {
      voice_text,
      original_chars: original.length,
      voice_chars: voice_text.length,
    };
  }

  @Post('build-response')
  buildResponse(@Body() body: BuildVoiceResponseDto): VoiceControlledResponse {
    return this.responseController.build({
      text: body.text ?? '',
      hints: {
        userIntent: body.userIntent,
        action: body.action as VoiceControlledResponse['action'] | undefined,
      },
    });
  }

  @Post('tts-status')
  ttsStatus(): { quotaBlocked: boolean } {
    return { quotaBlocked: this.ttsGateway.isQuotaBlocked() };
  }
}
