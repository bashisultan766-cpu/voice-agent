import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../../common/decorators/public.decorator';
import {
  buildElevenLabsConvaiAgentConfig,
  ELEVENLABS_CONVAI_PUBLIC_BASE_URL,
} from './elevenlabs-convai-sureshot.config';
import { ElevenLabsTwilioRegisterCallService } from './elevenlabs-twilio-register-call.service';
import { buildElevenLabsEricAgentConfig } from './elevenlabs-convai-eric.config';

function maskAgentId(agentId: string): string {
  if (agentId.length <= 12) return agentId;
  return `${agentId.slice(0, 12)}...`;
}

/**
 * Exportable ConvAI agent prompt + tool URLs for ElevenLabs dashboard setup.
 * GET /api/elevenlabs/convai/agent-config — Eric SureShot Books (production tools)
 */
@Public()
@Controller('elevenlabs/convai')
export class ElevenLabsConvaiController {
  constructor(
    private readonly config: ConfigService,
    private readonly registerCall: ElevenLabsTwilioRegisterCallService,
  ) {}

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

  /**
   * Twilio ↔ ElevenLabs bridge checklist — verify agent ID and webhooks match dashboard.
   * GET /api/elevenlabs/convai/bridge-status
   */
  @Get('bridge-status')
  bridgeStatus() {
    const publicBaseUrl =
      this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL')?.trim() ||
      ELEVENLABS_CONVAI_PUBLIC_BASE_URL;
    const agentId = this.registerCall.resolveAgentId();
    const hasApiKey = Boolean(
      this.config.get<string>('ELEVENLABS_API_KEY')?.trim() ||
        process.env.ELEVENLABS_API_KEY?.trim(),
    );
    const skipFirstMessageOverride =
      this.config.get<string>('ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE')?.trim() === 'true' ||
      process.env.ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE?.trim() === 'true';

    return {
      ok: hasApiKey,
      bridge: 'twilio_register_call',
      resolved_agent_id: agentId,
      resolved_agent_id_masked: maskAgentId(agentId),
      elevenlabs_api_key_configured: hasApiKey,
      skip_first_message_override: skipFirstMessageOverride,
      twilio_inbound_webhook: `${publicBaseUrl}/api/elevenlabs/inbound`,
      twilio_call_status_webhook: `${publicBaseUrl}/api/elevenlabs/call-status`,
      call_diagnostics_pattern: `${publicBaseUrl}/api/voice/call-diagnostics/{CallSid}`,
      checklist: [
        'Twilio voice URL must be POST .../api/elevenlabs/inbound (NOT api.us.elevenlabs.io/twilio/inbound_call).',
        'Twilio Call status changes must be POST .../api/elevenlabs/call-status.',
        'ELEVENLABS_CONVAI_AGENT_ID on VPS must exactly match the PUBLISHED agent in ElevenLabs dashboard.',
        'ElevenLabs → Phone Numbers: import Twilio number and assign it to the same published agent.',
        'If call drops instantly after publish: set ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE=true and restart API to test.',
        'After a failed call: GET call-diagnostics/{CallSid} with x-voice-api-key.',
      ],
    };
  }
}
