import { Injectable } from '@nestjs/common';
import { ElevenLabsService } from './elevenlabs.service';
import { firstSpeakableChunk } from '../../calls/runtime/voice-response-chunker.util';
import { summarizeForVoice, stubIntentForVoiceSummary } from '../../voice-intent-pipeline/voice-summarizer.util';

export type ChunkTtsResult = {
  audio: Buffer;
  characterCount: number;
  generationMs: number;
  chunkText: string;
};

/**
 * Chunked TTS for incremental playback — synthesize first sentence before full reply completes.
 */
@Injectable()
export class ElevenLabsStreamingService {
  constructor(private readonly elevenLabs: ElevenLabsService) {}

  async synthesizeFirstChunk(
    fullText: string,
    options?: { apiKey?: string; voiceId?: string; modelId?: string },
  ): Promise<ChunkTtsResult | null> {
    const chunkText = firstSpeakableChunk(fullText);
    if (!chunkText.trim()) return null;
    const started = Date.now();
    const audio = await this.elevenLabs.textToSpeech(chunkText, options?.voiceId, {
      apiKey: options?.apiKey,
      modelId: options?.modelId,
      latencyMode: true,
      voiceCall: true,
    });
    return {
      audio,
      characterCount: chunkText.length,
      generationMs: Date.now() - started,
      chunkText,
    };
  }

  async synthesizeFull(text: string, options?: { apiKey?: string; voiceId?: string; modelId?: string }) {
    const started = Date.now();
    const audio = await this.elevenLabs.textToSpeech(text, options?.voiceId, {
      apiKey: options?.apiKey,
      modelId: options?.modelId,
      latencyMode: true,
      voiceCall: true,
    });
    return {
      audio,
      characterCount: text.length,
      generationMs: Date.now() - started,
    };
  }

  /** Single TTS API call — compressed full reply (replaces first-chunk + full pattern). */
  async synthesizeOnce(
    fullText: string,
    options?: { apiKey?: string; voiceId?: string; modelId?: string },
  ): Promise<ChunkTtsResult | null> {
    const chunkText = summarizeForVoice({
      text_response: fullText,
      intent: stubIntentForVoiceSummary(fullText),
      actions_executed: [],
    });
    if (!chunkText.trim()) return null;
    const started = Date.now();
    const audio = await this.elevenLabs.textToSpeech(chunkText, options?.voiceId, {
      apiKey: options?.apiKey,
      modelId: options?.modelId,
      latencyMode: true,
      voiceCall: true,
    });
    return {
      audio,
      characterCount: chunkText.length,
      generationMs: Date.now() - started,
      chunkText,
    };
  }
}
