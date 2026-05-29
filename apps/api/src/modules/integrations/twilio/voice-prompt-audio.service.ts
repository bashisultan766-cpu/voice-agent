import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { buildTtsPlaybackUrl, validateTtsAudioBuffer } from './voice-elevenlabs-playback.util';

interface PhraseEntry {
  buffer: Buffer;
  expiresAt: number;
}

/** Pre-warm at startup / first call to cut ElevenLabs latency on hot paths. */
export const VOICE_PRELOADED_PHRASES = [
  'Hello! How can I help you today?',
  "You're welcome. What else can I help with?",
  'Of course. What would you like me to repeat?',
  'Sure, let me check that for you.',
  'Please tell me your email address so I can send your payment link.',
  'Is that email correct?',
  'Great. What would you like to do next?',
] as const;

/**
 * Long-lived in-memory cache of ElevenLabs audio for short fixed prompts (greeting, defer kickoff, etc.).
 * Each webhook issues a fresh Twilio TTS token via {@link TwilioTtsCacheService}; phrase cache avoids repeat EL API calls.
 */
@Injectable()
export class VoicePromptAudioService {
  private readonly phraseBuffers = new Map<string, PhraseEntry>();
  private readonly phraseTtlMs = 24 * 60 * 60 * 1000;

  constructor(
    private readonly elevenLabs: ElevenLabsService,
    private readonly ttsCache: TwilioTtsCacheService,
  ) {}

  /** Fire-and-forget preload of common phrases (no-op without voiceId/apiKey). */
  warmPreloadedPhrases(opts: { voiceId: string; apiKey?: string; modelId?: string }): void {
    const vid = opts.voiceId?.trim();
    if (!vid) return;
    for (const text of VOICE_PRELOADED_PHRASES) {
      void this.ensurePhraseBuffer(text, vid, opts.apiKey, opts.modelId).catch(() => undefined);
    }
  }

  private async ensurePhraseBuffer(
    text: string,
    voiceId: string,
    apiKey?: string,
    modelId?: string,
  ): Promise<void> {
    const model = modelId?.trim() || 'eleven_multilingual_v2';
    const k = this.cacheKey(voiceId, model, text);
    const hit = this.phraseBuffers.get(k);
    if (hit && hit.expiresAt > Date.now()) return;
    const buffer = await this.elevenLabs.textToSpeech(text, voiceId, { apiKey, modelId: model });
    this.phraseBuffers.set(k, { buffer, expiresAt: Date.now() + this.phraseTtlMs });
  }

  private cacheKey(voiceId: string, modelId: string, text: string): string {
    const t = text.trim().slice(0, 2000);
    return createHash('sha256').update(`${voiceId}\0${modelId}\0${t}`, 'utf8').digest('hex');
  }

  /**
   * Returns a one-time playback URL for Twilio &lt;Play&gt;, or undefined if ElevenLabs is unavailable.
   */
  async createPhrasePlaybackUrl(
    publicOrigin: string,
    opts: {
      text: string;
      voiceId: string;
      apiKey?: string;
      modelId?: string;
    },
  ): Promise<{ playbackUrl?: string; fromPhraseCache: boolean }> {
    const modelId = opts.modelId?.trim() || 'eleven_multilingual_v2';
    const vid = opts.voiceId.trim();
    const text = opts.text.trim().slice(0, 500);
    if (!text || !vid || !/^https:\/\//i.test(publicOrigin)) {
      return { playbackUrl: undefined, fromPhraseCache: false };
    }

    const k = this.cacheKey(vid, modelId, text);
    const now = Date.now();
    let buffer: Buffer | undefined;
    let fromPhraseCache = false;
    const hit = this.phraseBuffers.get(k);
    if (hit && hit.expiresAt > now) {
      buffer = hit.buffer;
      fromPhraseCache = true;
    } else {
      try {
        buffer = await this.elevenLabs.textToSpeech(text, vid, {
          apiKey: opts.apiKey,
          modelId,
        });
        this.phraseBuffers.set(k, { buffer, expiresAt: now + this.phraseTtlMs });
      } catch {
        return { playbackUrl: undefined, fromPhraseCache: false };
      }
    }

    const validation = validateTtsAudioBuffer(buffer);
    if (!validation.valid) {
      return { playbackUrl: undefined, fromPhraseCache };
    }

    const token = this.ttsCache.put(buffer);
    const playbackUrl = buildTtsPlaybackUrl(publicOrigin, token);
    return { playbackUrl, fromPhraseCache };
  }
}
