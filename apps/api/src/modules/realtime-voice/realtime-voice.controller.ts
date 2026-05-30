import { Controller, Get, Post, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { RealtimeVoiceOrchestratorService } from './orchestrator/realtime-voice-orchestrator.service';
import { OpenAiRealtimeService } from './streaming/openai-realtime.service';
import {
  isFullDuplexVoiceEnabled,
  isGatherFallbackEnabled,
  isElevenLabsStreamingTtsEnabled,
  isOpenAiRealtimeEnabled,
  isVoiceMediaStreamEnabled,
} from './config/realtime-voice-flags.util';

@Controller('realtime-voice')
export class RealtimeVoiceController {
  constructor(
    private readonly orchestrator: RealtimeVoiceOrchestratorService,
    private readonly openAiRealtime: OpenAiRealtimeService,
  ) {}

  @Get('health')
  health() {
    return {
      ok: true,
      multiAgentEnabled: this.orchestrator.isEnabled(),
      fullDuplexEnabled: isFullDuplexVoiceEnabled(),
      flags: {
        VOICE_MEDIA_STREAM_ENABLED: isVoiceMediaStreamEnabled(),
        OPENAI_REALTIME_ENABLED: isOpenAiRealtimeEnabled(),
        ELEVENLABS_STREAMING_TTS_ENABLED: isElevenLabsStreamingTtsEnabled(),
        GATHER_FALLBACK_ENABLED: isGatherFallbackEnabled(),
        REALTIME_MULTI_AGENT_ENABLED: this.orchestrator.isEnabled(),
      },
      endpoints: {
        mediaStream: '/api/realtime-voice/media-stream',
        devWs: '/api/realtime-voice/ws',
      },
      architecture: 'multi_agent_langgraph_v1_full_duplex',
      agents: [
        'router',
        'conversation',
        'shopify_search',
        'isbn_search',
        'email_verification',
        'payment_link',
        'memory',
        'voice_streaming',
        'background_task',
        'analytics',
      ],
    };
  }

  @Roles(UserRole.MANAGER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('turn')
  async turn(
    @Body()
    body: {
      callSessionId: string;
      utterance: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
  ) {
    return this.orchestrator.processUtterance(body.callSessionId, body.utterance, body.history ?? []);
  }

  @Roles(UserRole.MANAGER)
  @Get('realtime/session-template')
  sessionTemplate() {
    return this.openAiRealtime.buildSessionUpdate({ apiKey: 'placeholder' });
  }
}
