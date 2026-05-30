import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getRealtimePipelineFlags,
  readEnvFlag,
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

    this.logger.log(
      JSON.stringify({
        event: 'realtime_pipeline_enabled',
        voiceMediaStream: flags.voiceMediaStream,
        openaiRealtime: flags.openaiRealtime,
        multiAgent: flags.multiAgent,
        elevenlabsStreaming: flags.elevenlabsStreaming,
        gatherFallback: flags.gatherFallback,
        fullDuplex: flags.fullDuplex,
        legacyMediaStream: flags.legacyMediaStream,
        inboundPipelinePath: inboundPath,
        mediaStreamWsPath: flags.fullDuplex
          ? '/api/realtime-voice/media-stream'
          : flags.legacyMediaStream
            ? '/api/twilio/voice/media-stream'
            : null,
        envRaw: {
          VOICE_MEDIA_STREAM_ENABLED: process.env.VOICE_MEDIA_STREAM_ENABLED ?? null,
          OPENAI_REALTIME_ENABLED: process.env.OPENAI_REALTIME_ENABLED ?? null,
          REALTIME_MULTI_AGENT_ENABLED: process.env.REALTIME_MULTI_AGENT_ENABLED ?? null,
        },
        parsedTruthy: {
          VOICE_MEDIA_STREAM_ENABLED: readEnvFlag('VOICE_MEDIA_STREAM_ENABLED'),
          OPENAI_REALTIME_ENABLED: readEnvFlag('OPENAI_REALTIME_ENABLED'),
          REALTIME_MULTI_AGENT_ENABLED: readEnvFlag('REALTIME_MULTI_AGENT_ENABLED'),
        },
      }),
    );

    if (!flags.fullDuplex) {
      this.logger.warn(
        JSON.stringify({
          event: 'realtime_pipeline_not_full_duplex',
          inboundPipelinePath: inboundPath,
          fix:
            'Set VOICE_MEDIA_STREAM_ENABLED=true, OPENAI_REALTIME_ENABLED=true, REALTIME_MULTI_AGENT_ENABLED=true (values: true/1/yes/on) then restart API.',
        }),
      );
    }
  }
}
