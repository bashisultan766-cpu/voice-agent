import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { VoiceAudioCacheService } from './voice-audio-cache.service';
import { buildTtsPlaybackUrl, validateTtsAudioBuffer } from './voice-elevenlabs-playback.util';
import { VOICE_CACHED_PHRASES } from '../../calls/runtime/instant-reply.util';
import {
  GENERIC_FILLERS,
  SEARCH_FILLERS,
} from '../../search/voice/voice-search-filler.util';

interface PhraseEntry {
  buffer: Buffer;
  expiresAt: number;
}

/** All phrases warmed at startup for zero-latency playback on calls. */
export const VOICE_PRELOADED_PHRASES = [
  VOICE_CACHED_PHRASES.greeting,
  VOICE_CACHED_PHRASES.salam,
  VOICE_CACHED_PHRASES.howAreYou,
  VOICE_CACHED_PHRASES.thanks,
  VOICE_CACHED_PHRASES.yes,
  VOICE_CACHED_PHRASES.no,
  VOICE_CACHED_PHRASES.okay,
  VOICE_CACHED_PHRASES.goodbye,
  VOICE_CACHED_PHRASES.namaste,
  VOICE_CACHED_PHRASES.searchAck,
  VOICE_CACHED_PHRASES.productCorrection,
  VOICE_CACHED_PHRASES.emailPrompt,
  VOICE_CACHED_PHRASES.emailSpell,
  VOICE_CACHED_PHRASES.emailConfirm,
  VOICE_CACHED_PHRASES.thankYouOrder,
  VOICE_CACHED_PHRASES.repeat,
  VOICE_CACHED_PHRASES.speakEnglish,
  VOICE_CACHED_PHRASES.oneMoment,
  VOICE_CACHED_PHRASES.checking,
  VOICE_CACHED_PHRASES.verifying,
  ...SEARCH_FILLERS,
  ...GENERIC_FILLERS,
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
    private readonly audioCache: VoiceAudioCacheService,
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

    const persisted = await this.audioCache.getBuffer(k);
    if (persisted) {
      this.phraseBuffers.set(k, { buffer: persisted, expiresAt: Date.now() + this.phraseTtlMs });
      this.audioCache.logCacheEvent(true, k, 'redis', undefined);
      return;
    }

    const started = Date.now();
    const buffer = await this.elevenLabs.textToSpeech(text, voiceId, {
      apiKey,
      modelId: model,
      latencyMode: true,
    });
    this.phraseBuffers.set(k, { buffer, expiresAt: Date.now() + this.phraseTtlMs });
    void this.audioCache.setBuffer(k, buffer);
    this.audioCache.logCacheWarm(k, Date.now() - started, model, text);
  }

  resolveLatencyModelId(modelId?: string | null): string {
    const configured = modelId?.trim();
    if (configured) return configured;
    return process.env.ELEVENLABS_LATENCY_MODEL_ID?.trim() || 'eleven_turbo_v2_5';
  }

  private cacheKey(voiceId: string, modelId: string, text: string): string {
    return this.audioCache.audioHash(voiceId, modelId, text);
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
    audioServedFromCache: boolean;
  } {
    const modelId = this.resolveLatencyModelId(opts.modelId);
    const vid = opts.voiceId.trim();
    const text = opts.text.trim().slice(0, 500);
    const audioCacheKey = this.cacheKey(vid, modelId, text);
    if (!text || !vid || !/^https:\/\//i.test(publicOrigin)) {
      this.logAudioCache(false, audioCacheKey, 'miss', opts.callSessionId);
      return {
        fromPhraseCache: false,
        audioCacheKey,
        ttsGenerated: false,
        audioServedFromCache: false,
      };
    }

    const hit = this.phraseBuffers.get(audioCacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      const playback = this.bufferToPlayback(publicOrigin, hit.buffer, audioCacheKey, opts.callSessionId);
      if (playback) {
        this.logAudioCache(true, audioCacheKey, 'memory', opts.callSessionId);
        return {
          playbackUrl: playback,
          fromPhraseCache: true,
          audioCacheKey,
          ttsGenerated: false,
          audioServedFromCache: true,
        };
      }
    }

    this.logAudioCache(false, audioCacheKey, 'miss', opts.callSessionId);
    return {
      fromPhraseCache: false,
      audioCacheKey,
      ttsGenerated: false,
      audioServedFromCache: false,
    };
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
    audioServedFromCache?: boolean;
    ttsLatencyMs?: number;
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
      return {
        ...cached,
        elevenlabsModel: modelId,
        audioServedFromCache: cached.fromPhraseCache,
        ttsLatencyMs: 0,
      };
    }

    const persisted = await this.audioCache.getBuffer(audioCacheKey);
    if (persisted) {
      this.phraseBuffers.set(audioCacheKey, {
        buffer: persisted,
        expiresAt: Date.now() + this.phraseTtlMs,
      });
      const playbackUrl = this.bufferToPlayback(publicOrigin, persisted, audioCacheKey, opts.callSessionId);
      if (playbackUrl) {
        this.audioCache.logCacheEvent(true, audioCacheKey, 'redis', opts.callSessionId);
        return {
          playbackUrl,
          fromPhraseCache: true,
          audioCacheKey,
          ttsGenerated: false,
          elevenlabsModel: modelId,
          audioServedFromCache: true,
          ttsLatencyMs: 0,
        };
      }
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
      void this.audioCache.setBuffer(audioCacheKey, buffer);
      const validation = validateTtsAudioBuffer(buffer);
      if (!validation.valid) {
        return {
          playbackUrl: undefined,
          fromPhraseCache: false,
          audioCacheKey,
          ttsGenerated: true,
          elevenlabsLatencyMs,
          elevenlabsModel: modelId,
          audioServedFromCache: false,
          ttsLatencyMs: elevenlabsLatencyMs,
        };
      }
      const token = this.ttsCache.put(buffer);
      this.logger.log(
        JSON.stringify({
          event: 'voice.tts.generated',
          ttsLatencyMs: elevenlabsLatencyMs,
          elevenlabsModel: modelId,
          audioServedFromCache: false,
          callSessionId: opts.callSessionId ?? null,
        }),
      );
      return {
        playbackUrl: buildTtsPlaybackUrl(publicOrigin, token),
        fromPhraseCache: false,
        audioCacheKey,
        ttsGenerated: true,
        elevenlabsLatencyMs,
        elevenlabsModel: modelId,
        audioServedFromCache: false,
        ttsLatencyMs: elevenlabsLatencyMs,
      };
    } catch {
      return {
        playbackUrl: undefined,
        fromPhraseCache: false,
        audioCacheKey,
        ttsGenerated: false,
        elevenlabsModel: modelId,
        audioServedFromCache: false,
      };
    }
  }

  private bufferToPlayback(
    publicOrigin: string,
    buffer: Buffer,
    audioCacheKey: string,
    callSessionId?: string,
  ): string | undefined {
    const validation = validateTtsAudioBuffer(buffer);
    if (!validation.valid) return undefined;
    const token = this.ttsCache.put(buffer);
    return buildTtsPlaybackUrl(publicOrigin, token);
  }

  private logAudioCache(
    hit: boolean,
    audioCacheKey: string,
    layer: 'memory' | 'redis' | 'disk' | 'miss',
    callSessionId?: string,
  ): void {
    this.audioCache.logCacheEvent(hit, audioCacheKey, layer, callSessionId);
  }
}
