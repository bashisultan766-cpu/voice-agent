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
      const first = await this.elevenLabsStream.synthesizeFirstChunk(text, {
        apiKey: apiKey || undefined,
        voiceId: voiceId || undefined,
        modelId: modelId || undefined,
      });

      const chunks: VoiceStreamChunk[] = [];
      if (first) {
        chunks.push({
          text: first.chunkText,
          audio: first.audio,
          isFinal: first.chunkText.length >= text.length,
          generationMs: first.generationMs,
        });
        this.events.emit('stream.chunk', {
          callSessionId: state.callSessionId,
          text: first.chunkText,
          latencyMs: first.generationMs,
        });
      }

      if (state.reply && state.reply !== state.immediateFiller && state.reply.length > (first?.chunkText.length ?? 0)) {
        const full = await this.elevenLabsStream.synthesizeFull(state.reply, {
          apiKey: apiKey || undefined,
          voiceId: voiceId || undefined,
          modelId: modelId || undefined,
        });
        chunks.push({
          text: state.reply,
          audio: full.audio,
          isFinal: true,
          generationMs: full.generationMs,
        });
      }

      return chunks;
    } catch (err) {
      this.logger.warn(`VoiceStreamingAgent: ${(err as Error).message}`);
      return [{ text, isFinal: true }];
    }
  }
}
