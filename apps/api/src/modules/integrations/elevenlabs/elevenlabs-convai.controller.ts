import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../../common/decorators/public.decorator';
import {
  buildElevenLabsConvaiAgentConfig,
  ELEVENLABS_CONVAI_PUBLIC_BASE_URL,
} from './elevenlabs-convai-sureshot.config';
import { buildElevenLabsEricAgentConfig } from './elevenlabs-convai-eric.config';

/**
 * Exportable ConvAI agent prompt + tool URLs for ElevenLabs dashboard setup.
 * GET /api/elevenlabs/convai/agent-config — Eric SureShot Books (production tools)
 */
@Public()
@Controller('elevenlabs/convai')
export class ElevenLabsConvaiController {
  constructor(private readonly config: ConfigService) {}

  @Get('agent-config')
  agentConfig() {
    const publicBaseUrl =
      this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL')?.trim() ||
      ELEVENLABS_CONVAI_PUBLIC_BASE_URL;
    return buildElevenLabsConvaiAgentConfig(publicBaseUrl);
  }

  /** Legacy Eric 3CX-only config (caller recognition tools only). */
  @Get('eric-agent-config')
  ericAgentConfig() {
    const publicBaseUrl =
      this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL')?.trim() ||
      ELEVENLABS_CONVAI_PUBLIC_BASE_URL;
    return buildElevenLabsEricAgentConfig(publicBaseUrl);
  }
}
