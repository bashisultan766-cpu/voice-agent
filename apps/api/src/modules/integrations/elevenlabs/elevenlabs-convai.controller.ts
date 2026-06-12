import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../../common/decorators/public.decorator';
import { buildElevenLabsConvaiAgentConfig } from './elevenlabs-convai-sureshot.config';
import { buildElevenLabsEricAgentConfig } from './elevenlabs-convai-eric.config';

/**
 * Exportable ConvAI agent prompt + tool URLs for ElevenLabs dashboard setup.
 * GET /api/elevenlabs/convai/agent-config
 */
@Public()
@Controller('elevenlabs/convai')
export class ElevenLabsConvaiController {
  constructor(private readonly config: ConfigService) {}

  @Get('agent-config')
  agentConfig() {
    const publicBaseUrl =
      this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL')?.trim() ||
      `http://localhost:${this.config.get<string>('PORT') ?? '3001'}`;
    return buildElevenLabsConvaiAgentConfig(publicBaseUrl);
  }

  /** Eric — live 3CX caller recognition agent (GetCallerInfo + SaveCallerName). */
  @Get('eric-agent-config')
  ericAgentConfig() {
    const publicBaseUrl =
      this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL')?.trim() ||
      `http://localhost:${this.config.get<string>('PORT') ?? '3001'}`;
    return buildElevenLabsEricAgentConfig(publicBaseUrl);
  }
}
