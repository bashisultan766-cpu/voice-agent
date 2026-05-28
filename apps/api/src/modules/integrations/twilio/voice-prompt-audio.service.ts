import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { buildTtsPlaybackUrl, validateTtsAudioBuffer } from './voice-elevenlabs-playback.util';

interface PhraseEntry {
  buffer: Buffer;
  expiresAt: number;
}

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
