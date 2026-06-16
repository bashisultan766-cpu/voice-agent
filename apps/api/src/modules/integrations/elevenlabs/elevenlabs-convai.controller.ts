import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../../common/decorators/public.decorator';
import {
  buildElevenLabsConvaiAgentConfig,
  ELEVENLABS_CONVAI_PUBLIC_BASE_URL,
} from './elevenlabs-convai-sureshot.config';
import { ElevenLabsTwilioRegisterCallService } from './elevenlabs-twilio-register-call.service';
import { LastTwimlDebugService } from './last-twiml-debug.service';
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
    private readonly lastTwimlDebug: LastTwimlDebugService,
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
    const branchId = this.registerCall.resolveBranchId();
    const hasApiKey = Boolean(
      this.config.get<string>('ELEVENLABS_API_KEY')?.trim() ||
        process.env.ELEVENLABS_API_KEY?.trim(),
    );
    const skipFirstMessageOverride =
      this.config.get<string>('ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE')?.trim() === 'true' ||
      process.env.ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE?.trim() === 'true';
    const minimalRegisterCall = this.registerCall.isMinimalRegisterCallMode();
    const branchIdPresent = Boolean(branchId);
    const debugTwimlEnabled = this.registerCall.isDebugTwimlMode();
    const forceBranchId = this.registerCall.isForceBranchIdMode();
    const disableMinimalOn31921Flag = this.registerCall.isDisableMinimalOn31921FlagSet();
    const lastTwiml = this.lastTwimlDebug.getLast();
    const lastStatus = this.lastTwimlDebug.getLastStatus();
    const postTwimlLikelyIssue = this.lastTwimlDebug.isPostTwiml31921Issue();

    return {
      ok: hasApiKey,
      bridge: 'twilio_register_call',
      resolved_agent_id: agentId,
      resolved_agent_id_masked: maskAgentId(agentId),
      resolved_branch_id: branchId,
      elevenlabs_api_key_configured: hasApiKey,
      skip_first_message_override: skipFirstMessageOverride,
      minimal_register_call: minimalRegisterCall,
      minimalRegisterCall,
      branchIdPresent,
      debugTwimlEnabled,
      forceBranchId,
      disableMinimalOn31921Flag,
      expectedTtsFormat: 'mu-law 8000 Hz',
      postTwimlLikelyIssue,
      last_twiml_has_stream: lastTwiml?.hasStream ?? null,
      last_status_error_code: lastStatus?.errorCode ?? null,
      twilio_stream_error_31921:
        'Post-TwiML WebSocket close — Twilio opened ElevenLabs stream but ElevenLabs closed it.',
      recommended_test_modes: {
        mode_a_minimal: {
          description: 'Simplest register-call — agent_id + phones only',
          env: {
            ELEVENLABS_MINIMAL_REGISTER_CALL: 'true',
            ELEVENLABS_CONVAI_BRANCH_ID: '',
            ELEVENLABS_FORCE_BRANCH_ID: 'false',
          },
        },
        mode_b_branch: {
          description: 'Full register-call with published branch ID',
          env: {
            ELEVENLABS_MINIMAL_REGISTER_CALL: 'false',
            ELEVENLABS_CONVAI_BRANCH_ID: 'agtbrch_1101kswaf3w6et29hfmdhxz8h03v',
            ELEVENLABS_FORCE_BRANCH_ID: 'true',
          },
        },
      },
      recommended_env_on_31921: disableMinimalOn31921Flag
        ? 'ELEVENLABS_DISABLE_MINIMAL_ON_31921 is set — manually switch to Mode B (minimal=false + branch + FORCE_BRANCH_ID=true), restart API, retest.'
        : 'If ErrorCode 31921 persists in call-status: try Mode B env, verify ElevenLabs phone import and TTS μ-law 8000 Hz.',
      twilio_inbound_webhook: `${publicBaseUrl}/api/elevenlabs/inbound`,
      twilio_call_status_webhook: `${publicBaseUrl}/api/elevenlabs/call-status`,
      last_twiml_debug: `${publicBaseUrl}/api/elevenlabs/convai/last-twiml`,
      call_diagnostics_pattern: `${publicBaseUrl}/api/voice/call-diagnostics/{CallSid}`,
      checklist: [
        'Twilio voice URL must be POST .../api/elevenlabs/inbound (NOT api.us.elevenlabs.io/twilio/inbound_call).',
        'Twilio Call status changes must be POST .../api/elevenlabs/call-status.',
        'ELEVENLABS_CONVAI_AGENT_ID on VPS must exactly match the PUBLISHED agent in ElevenLabs dashboard.',
        'After publish with versioning: set ELEVENLABS_CONVAI_BRANCH_ID=agtbrch_... from the agent URL if calls drop.',
        'Agent Voice TTS output must be μ-law 8000 Hz (NOT PCM 16000 Hz) for Twilio register-call.',
        'Twilio error 31921 = Stream WebSocket Close — post-TwiML ElevenLabs issue, not bad backend XML.',
        'Mode A test: ELEVENLABS_MINIMAL_REGISTER_CALL=true, clear ELEVENLABS_CONVAI_BRANCH_ID.',
        'Mode B test: ELEVENLABS_MINIMAL_REGISTER_CALL=false, set branch ID, ELEVENLABS_FORCE_BRANCH_ID=true.',
        'ELEVENLABS_DISABLE_MINIMAL_ON_31921 documents manual switch to Mode B — no auto runtime change.',
        'ElevenLabs → Phone Numbers: import Twilio number and assign it to the same published agent.',
        'If call drops instantly after publish: set ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE=true and restart API to test.',
        'After a failed call: GET call-diagnostics/{CallSid} with x-voice-api-key.',
        'After a failed call: GET .../convai/last-twiml for sanitized TwiML from the last register-call.',
        'Set ELEVENLABS_DEBUG_TWIML=true to log sanitized TwiML in pm2 logs on each call.',
      ],
    };
  }

  /**
   * Returns the last TwiML returned by ElevenLabs register-call (sanitized).
   * GET /api/elevenlabs/convai/last-twiml
   */
  @Get('last-twiml')
  lastTwiml() {
    const snapshot = this.lastTwimlDebug.getLast();
    if (!snapshot) {
      return {
        ok: false,
        message: 'No register-call TwiML recorded yet. Place a test call first.',
      };
    }

    return {
      ok: true,
      callSid: snapshot.callSid,
      timestamp: snapshot.timestamp,
      twimlBytes: snapshot.twimlBytes,
      hasConnect: snapshot.hasConnect,
      hasConversation: snapshot.hasConversation,
      hasStream: snapshot.hasStream,
      contentType: snapshot.contentType,
      twimlRepaired: snapshot.twimlRepaired,
      repairReason: snapshot.repairReason,
      sanitizedTwiml: snapshot.sanitizedTwiml,
      lastStatus: this.lastTwimlDebug.getLastStatus(),
      postTwimlLikelyIssue: this.lastTwimlDebug.isPostTwiml31921Issue(),
    };
  }
}
