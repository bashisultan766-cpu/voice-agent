import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { buildTtsPlaybackUrl, validateTtsAudioBuffer } from './voice-elevenlabs-playback.util';
import { VOICE_CACHED_PHRASES } from '../../calls/runtime/instant-reply.util';

interface PhraseEntry {
  buffer: Buffer;
  expiresAt: number;
}

/** All phrases warmed at startup for zero-latency playback on calls. */
export const VOICE_PRELOADED_PHRASES = [
  VOICE_CACHED_PHRASES.greeting,
  VOICE_CACHED_PHRASES.salam,
  VOICE_CACHED_PHRASES.howAreYou,
  VOICE_CACHED_PHRASES.searchAck,
  VOICE_CACHED_PHRASES.emailPrompt,
  VOICE_CACHED_PHRASES.emailSpell,
  VOICE_CACHED_PHRASES.emailConfirm,
  VOICE_CACHED_PHRASES.thankYouOrder,
  VOICE_CACHED_PHRASES.repeat,
  VOICE_CACHED_PHRASES.speakEnglish,
  "You're welcome. What else can I help?",
  'Great. What would you like next?',
  'No problem. What can I help with?',
  'Sounds good. How can I help?',
  'Namaste. How can I help you today?',
] as const;

/**
 * Long-lived in-memory cache of ElevenLabs audio for short fixed prompts.
 * Hot path uses cache-only resolution — never blocks on ElevenLabs API during a call.
 */
@Injectable()
export class VoicePromptAudioService {
  private readonly logger = new Logger(VoicePromptAudioService.name);
  private readonly phraseBuffers = new Map<string, PhraseEntry>();
  private readonly phraseTtlMs = 7 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly elevenLabs: ElevenLabsService,
    private readonly ttsCache: TwilioTtsCacheService,
  ) {}

  audioCacheKey(voiceId: string, modelId: string, text: string): string {
    return this.cacheKey(voiceId, modelId, text);
  }

  hasCachedPhrase(voiceId: string, modelId: string, text: string): boolean {
    const k = this.cacheKey(voiceId, modelId, text);
    const hit = this.phraseBuffers.get(k);
    return Boolean(hit && hit.expiresAt > Date.now());
  }

  /** Pre-generate audio at startup (before live calls). */
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
    const model = this.resolveLatencyModelId(modelId);
    const k = this.cacheKey(voiceId, model, text);
    const hit = this.phraseBuffers.get(k);
    if (hit && hit.expiresAt > Date.now()) return;
    const started = Date.now();
    const buffer = await this.elevenLabs.textToSpeech(text, voiceId, {
      apiKey,
      modelId: model,
      latencyMode: true,
    });
    this.phraseBuffers.set(k, { buffer, expiresAt: Date.now() + this.phraseTtlMs });
    this.logger.log(
      JSON.stringify({
        event: 'voice.audio_cache_warm',
        audioCacheKey: k.slice(0, 16),
        elevenlabsLatencyMs: Date.now() - started,
        elevenlabsModel: model,
        phrasePreview: text.slice(0, 60),
      }),
    );
  }

  resolveLatencyModelId(modelId?: string | null): string {
    const configured = modelId?.trim();
    if (configured) return configured;
    return process.env.ELEVENLABS_LATENCY_MODEL_ID?.trim() || 'eleven_turbo_v2_5';
  }

  private cacheKey(voiceId: string, modelId: string, text: string): string {
    const t = text.trim().slice(0, 2000);
    return createHash('sha256').update(`${voiceId}\0${modelId}\0${t}`, 'utf8').digest('hex');
  }

  /**
   * Hot path: return playback URL only if audio is already cached.
   * Never calls ElevenLabs API — use Twilio Say fallback on miss.
   */
  resolveCachedPhrasePlaybackUrl(
    publicOrigin: string,
    opts: {
      text: string;
      voiceId: string;
      modelId?: string;
      callSessionId?: string;
    },
  ): {
    playbackUrl?: string;
    fromPhraseCache: boolean;
    audioCacheKey: string;
    ttsGenerated: boolean;
  } {
    const modelId = this.resolveLatencyModelId(opts.modelId);
    const vid = opts.voiceId.trim();
    const text = opts.text.trim().slice(0, 500);
    const audioCacheKey = this.cacheKey(vid, modelId, text);
    if (!text || !vid || !/^https:\/\//i.test(publicOrigin)) {
      this.logAudioCache(false, audioCacheKey, opts.callSessionId);
      return { fromPhraseCache: false, audioCacheKey, ttsGenerated: false };
    }

    const hit = this.phraseBuffers.get(audioCacheKey);
    if (!hit || hit.expiresAt <= Date.now()) {
      this.logAudioCache(false, audioCacheKey, opts.callSessionId);
      return { fromPhraseCache: false, audioCacheKey, ttsGenerated: false };
    }

    const validation = validateTtsAudioBuffer(hit.buffer);
    if (!validation.valid) {
      this.logAudioCache(false, audioCacheKey, opts.callSessionId);
      return { fromPhraseCache: false, audioCacheKey, ttsGenerated: false };
    }

    const token = this.ttsCache.put(hit.buffer);
    const playbackUrl = buildTtsPlaybackUrl(publicOrigin, token);
    this.logAudioCache(true, audioCacheKey, opts.callSessionId);
    return { playbackUrl, fromPhraseCache: true, audioCacheKey, ttsGenerated: false };
  }

  /**
   * Returns a one-time playback URL; may call ElevenLabs on cache miss (deferred path only).
   */
  async createPhrasePlaybackUrl(
    publicOrigin: string,
    opts: {
      text: string;
      voiceId: string;
      apiKey?: string;
      modelId?: string;
      callSessionId?: string;
      cacheOnly?: boolean;
    },
  ): Promise<{
    playbackUrl?: string;
    fromPhraseCache: boolean;
    audioCacheKey: string;
    ttsGenerated: boolean;
    elevenlabsLatencyMs?: number;
    elevenlabsModel?: string;
  }> {
    const modelId = this.resolveLatencyModelId(opts.modelId);
    const vid = opts.voiceId.trim();
    const text = opts.text.trim().slice(0, 500);
    const audioCacheKey = this.cacheKey(vid, modelId, text);
    if (!text || !vid || !/^https:\/\//i.test(publicOrigin)) {
      return { playbackUrl: undefined, fromPhraseCache: false, audioCacheKey, ttsGenerated: false };
    }

    const cached = this.resolveCachedPhrasePlaybackUrl(publicOrigin, {
      text,
      voiceId: vid,
      modelId,
      callSessionId: opts.callSessionId,
    });
    if (cached.playbackUrl || opts.cacheOnly) {
      return { ...cached, elevenlabsModel: modelId };
    }

    let elevenlabsLatencyMs = 0;
    try {
      const started = Date.now();
      const buffer = await this.elevenLabs.textToSpeech(text, vid, {
        apiKey: opts.apiKey,
        modelId,
        latencyMode: true,
      });
      elevenlabsLatencyMs = Date.now() - started;
      this.phraseBuffers.set(audioCacheKey, {
        buffer,
        expiresAt: Date.now() + this.phraseTtlMs,
      });
      const validation = validateTtsAudioBuffer(buffer);
      if (!validation.valid) {
        return {
          playbackUrl: undefined,
          fromPhraseCache: false,
          audioCacheKey,
          ttsGenerated: true,
          elevenlabsLatencyMs,
          elevenlabsModel: modelId,
        };
      }
      const token = this.ttsCache.put(buffer);
      return {
        playbackUrl: buildTtsPlaybackUrl(publicOrigin, token),
        fromPhraseCache: false,
        audioCacheKey,
        ttsGenerated: true,
        elevenlabsLatencyMs,
        elevenlabsModel: modelId,
      };
    } catch {
      return {
        playbackUrl: undefined,
        fromPhraseCache: false,
        audioCacheKey,
        ttsGenerated: false,
        elevenlabsModel: modelId,
      };
    }
  }

  private logAudioCache(hit: boolean, audioCacheKey: string, callSessionId?: string): void {
    this.logger.log(
      JSON.stringify({
        event: hit ? 'voice.audio_cache_hit' : 'voice.audio_cache_miss',
        audioCacheKey: audioCacheKey.slice(0, 16),
        callSessionId: callSessionId ?? null,
      }),
    );
  }
}
