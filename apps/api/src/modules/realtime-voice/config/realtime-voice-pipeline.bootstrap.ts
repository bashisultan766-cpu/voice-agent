import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getRealtimePipelineFlags,
  resolveInboundVoicePipelinePath,
} from './realtime-voice-flags.util';

/**
 * Logs effective realtime pipeline flags at startup and aligns ConfigService values with process.env.
 */
@Injectable()
export class RealtimeVoicePipelineBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(RealtimeVoicePipelineBootstrapService.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const flagKeys = [
      'VOICE_MEDIA_STREAM_ENABLED',
      'OPENAI_REALTIME_ENABLED',
      'REALTIME_MULTI_AGENT_ENABLED',
      'ELEVENLABS_STREAMING_TTS_ENABLED',
      'GATHER_FALLBACK_ENABLED',
    ] as const;

    for (const key of flagKeys) {
      const fromConfig = this.config.get<string>(key);
      if (fromConfig !== undefined && fromConfig !== null && String(fromConfig).trim() !== '') {
        process.env[key] = String(fromConfig).trim();
      }
    }

    const flags = getRealtimePipelineFlags();
    const inboundPath = resolveInboundVoicePipelinePath();

    this.logger.warn(
      JSON.stringify({
        event: 'realtime_pipeline_deprecated',
        reason: 'voice_consolidated_to_services_voice_agent',
        activeTwilioWebhook: 'POST https://<voice-host>/voice/incoming',
        activeMediaStream: 'wss://<voice-host>/ws/stream',
        flags,
        inboundPipelinePath: inboundPath,
      }),
    );
  }
}
