import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export type RealtimeSessionConfig = {
  apiKey: string;
  model?: string;
  voice?: string;
  instructions?: string;
};

/**
 * OpenAI Realtime API adapter — used for Media Streams / full-duplex path.
 * Gather MVP continues to use Twilio STT + multi-agent orchestrator.
 */
@Injectable()
export class OpenAiRealtimeService {
  private readonly logger = new Logger(OpenAiRealtimeService.name);
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService) {
    this.defaultModel =
      this.config.get<string>('OPENAI_REALTIME_MODEL')?.trim() || 'gpt-4o-mini-realtime-preview';
  }

  createClient(apiKey: string): OpenAI {
    return new OpenAI({ apiKey });
  }

  /** Session bootstrap payload for OpenAI Realtime WebSocket clients. */
  buildSessionUpdate(config: RealtimeSessionConfig): Record<string, unknown> {
    return {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions:
          config.instructions ??
          'You are a friendly bookstore phone sales agent. Keep responses concise for voice.',
        voice: config.voice ?? 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 },
        model: config.model ?? this.defaultModel,
      },
    };
  }

  async healthCheck(apiKey?: string): Promise<boolean> {
    const key = apiKey?.trim() || this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!key) return false;
    try {
      const client = this.createClient(key);
      await client.models.list();
      return true;
    } catch (err) {
      this.logger.warn(`OpenAI Realtime health check failed: ${(err as Error).message}`);
      return false;
    }
  }
}
