import { Injectable, Logger } from '@nestjs/common';
import { ElevenLabsStreamingService } from '../../integrations/elevenlabs/elevenlabs-streaming.service';
import { VoiceEventBusService } from '../events/voice-event-bus.service';
import type { VoiceGraphState } from '../types/voice-turn.types';

export type VoiceStreamChunk = {
  text: string;
  audio?: Buffer;
  isFinal: boolean;
  generationMs?: number;
};

/**
 * Voice Streaming Agent — ElevenLabs first-chunk TTS for sub-second perceived latency.
 */
@Injectable()
export class VoiceStreamingAgent {
  private readonly logger = new Logger(VoiceStreamingAgent.name);

  constructor(
    private readonly elevenLabsStream: ElevenLabsStreamingService,
    private readonly events: VoiceEventBusService,
  ) {}

  async streamReply(state: VoiceGraphState): Promise<VoiceStreamChunk[]> {
    const text = state.immediateFiller || state.reply;
    if (!text.trim()) return [];

    const apiKey = state.context.agent.elevenlabsApiKey?.trim();
    const voiceId = state.context.agent.voiceId?.trim();
    const modelId = state.context.agent.elevenlabsModel?.trim();

    try {
      const replyText = state.reply?.trim() || text;
      const once = await this.elevenLabsStream.synthesizeOnce(replyText, {
        apiKey: apiKey || undefined,
        voiceId: voiceId || undefined,
        modelId: modelId || undefined,
      });

      if (!once) return [{ text: replyText, isFinal: true }];

      this.events.emit('stream.chunk', {
        callSessionId: state.callSessionId,
        text: once.chunkText,
        latencyMs: once.generationMs,
      });

      return [
        {
          text: once.chunkText,
          audio: once.audio,
          isFinal: true,
          generationMs: once.generationMs,
        },
      ];
    } catch (err) {
      this.logger.warn(`VoiceStreamingAgent: ${(err as Error).message}`);
      return [{ text, isFinal: true }];
    }
  }
}
