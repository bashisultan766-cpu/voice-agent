import { Injectable, Logger } from '@nestjs/common';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { resolveElevenLabsVoiceModel } from '../elevenlabs/elevenlabs-voice-model.util';
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

/** Production-critical phrases — must use same model as runtime (ELEVENLABS_LATENCY_MODEL_ID). */
export const VOICE_PRODUCTION_PREWARM_PHRASES = [
  VOICE_CACHED_PHRASES.greeting,
  VOICE_CACHED_PHRASES.salamShort,
  VOICE_CACHED_PHRASES.searchAckShort,
  VOICE_CACHED_PHRASES.searchAck,
  VOICE_CACHED_PHRASES.checkoutIntro,
  VOICE_CACHED_PHRASES.emailPrompt,
  VOICE_CACHED_PHRASES.emailSpell,
  VOICE_CACHED_PHRASES.paymentLinkSent,
  VOICE_CACHED_PHRASES.thanks,
] as const;

/** All phrases warmed at startup for zero-latency playback on calls. */
export const VOICE_PRELOADED_PHRASES = [
  ...VOICE_PRODUCTION_PREWARM_PHRASES,
  VOICE_CACHED_PHRASES.salam,
  VOICE_CACHED_PHRASES.howAreYou,
  VOICE_CACHED_PHRASES.yes,
  VOICE_CACHED_PHRASES.no,
  VOICE_CACHED_PHRASES.okay,
  VOICE_CACHED_PHRASES.goodbye,
  VOICE_CACHED_PHRASES.namaste,
  VOICE_CACHED_PHRASES.productCorrection,
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

type CacheLayer = 'memory' | 'redis' | 'disk' | 'miss';

/**
 * Long-lived in-memory cache of ElevenLabs audio for short fixed prompts.
 * Hot path checks memory → Redis → disk before any ElevenLabs API call.
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

  /** Voice calls always use ELEVENLABS_LATENCY_MODEL_ID — agent DB model must not override. */
  resolveLatencyModelId(_agentModelId?: string | null): string {
    return resolveElevenLabsVoiceModel({ forceVoiceLatency: true }).selectedModel;
  }

  /** Pre-generate audio at startup using the latency model (blocks until complete). */
  async warmPreloadedPhrases(opts: {
    voiceId: string;
    apiKey?: string;
  }): Promise<{ warmed: number; modelId: string }> {
    const vid = opts.voiceId?.trim();
    if (!vid) return { warmed: 0, modelId: this.resolveLatencyModelId(null) };
    const modelId = this.resolveLatencyModelId(null);
    let warmed = 0;
    for (const text of VOICE_PRELOADED_PHRASES) {
      const ok = await this.ensurePhraseBuffer(text, vid, opts.apiKey, modelId);
      if (ok) warmed += 1;
    }
    return { warmed, modelId };
  }

  private async ensurePhraseBuffer(
    text: string,
    voiceId: string,
    apiKey: string | undefined,
    modelId: string,
  ): Promise<boolean> {
    const k = this.cacheKey(voiceId, modelId, text);
    const mem = this.phraseBuffers.get(k);
    if (mem && mem.expiresAt > Date.now()) return true;

    if (this.audioCache.isEnabled()) {
      const persisted = await this.audioCache.getBuffer(k);
      if (persisted) {
        this.phraseBuffers.set(k, { buffer: persisted, expiresAt: Date.now() + this.phraseTtlMs });
        this.audioCache.logCacheEvent(true, k, 'redis', undefined);
        return true;
      }
    }

    const started = Date.now();
    const buffer = await this.elevenLabs.textToSpeech(text, voiceId, {
      apiKey,
      latencyMode: true,
      voiceCall: true,
    });
    this.phraseBuffers.set(k, { buffer, expiresAt: Date.now() + this.phraseTtlMs });
    if (this.audioCache.isEnabled()) {
      void this.audioCache.setBuffer(k, buffer);
    }
    this.audioCache.logCacheWarm(k, Date.now() - started, modelId, text);
    return true;
  }

  private cacheKey(voiceId: string, modelId: string, text: string): string {
    return this.audioCache.audioHash(voiceId, modelId, text);
  }

  /**
   * Hot path: memory → Redis → disk. Never calls ElevenLabs API.
   */
  async resolveCachedPhrasePlaybackUrl(
    publicOrigin: string,
    opts: {
      text: string;
      voiceId: string;
      modelId?: string;
      callSessionId?: string;
    },
  ): Promise<{
    playbackUrl?: string;
    fromPhraseCache: boolean;
    audioCacheKey: string;
    ttsGenerated: boolean;
    audioServedFromCache: boolean;
    audioCacheHit: boolean;
    cacheLayer: CacheLayer;
  }> {
    const modelId = this.resolveLatencyModelId(opts.modelId);
    const vid = opts.voiceId.trim();
    const text = opts.text.trim().slice(0, 500);
    const audioCacheKey = this.cacheKey(vid, modelId, text);
    const miss = {
      fromPhraseCache: false,
      audioCacheKey,
      ttsGenerated: false,
      audioServedFromCache: false,
      audioCacheHit: false,
      cacheLayer: 'miss' as const,
    };
    if (!text || !vid || !/^https:\/\//i.test(publicOrigin)) {
      this.logAudioCache(false, audioCacheKey, 'miss', opts.callSessionId);
      return miss;
    }

    const fromMemory = this.getMemoryBuffer(audioCacheKey);
    if (fromMemory) {
      const playbackUrl = this.bufferToPlayback(publicOrigin, fromMemory);
      if (playbackUrl) {
        this.logAudioCache(true, audioCacheKey, 'memory', opts.callSessionId);
        return {
          playbackUrl,
          fromPhraseCache: true,
          audioCacheKey,
          ttsGenerated: false,
          audioServedFromCache: true,
          audioCacheHit: true,
          cacheLayer: 'memory',
        };
      }
    }

    if (this.audioCache.isEnabled()) {
      const persisted = await this.audioCache.getBuffer(audioCacheKey);
      if (persisted) {
        this.phraseBuffers.set(audioCacheKey, {
          buffer: persisted,
          expiresAt: Date.now() + this.phraseTtlMs,
        });
        const playbackUrl = this.bufferToPlayback(publicOrigin, persisted);
        if (playbackUrl) {
          const layer = this.audioCache.lastHitLayer ?? 'redis';
          this.logAudioCache(true, audioCacheKey, layer, opts.callSessionId);
          return {
            playbackUrl,
            fromPhraseCache: true,
            audioCacheKey,
            ttsGenerated: false,
            audioServedFromCache: true,
            audioCacheHit: true,
            cacheLayer: layer,
          };
        }
      }
    }

    this.logAudioCache(false, audioCacheKey, 'miss', opts.callSessionId);
    return miss;
  }

  /**
   * Returns a one-time playback URL; checks cache tiers before ElevenLabs API.
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
    audioCacheHit?: boolean;
    ttsLatencyMs?: number;
  }> {
    const modelId = this.resolveLatencyModelId(opts.modelId);
    const cached = await this.resolveCachedPhrasePlaybackUrl(publicOrigin, {
      text: opts.text,
      voiceId: opts.voiceId,
      modelId,
      callSessionId: opts.callSessionId,
    });
    if (cached.playbackUrl || opts.cacheOnly) {
      return {
        ...cached,
        elevenlabsModel: modelId,
        audioServedFromCache: cached.fromPhraseCache,
        audioCacheHit: cached.audioCacheHit,
        ttsLatencyMs: 0,
      };
    }

    let elevenlabsLatencyMs = 0;
    try {
      const started = Date.now();
      const buffer = await this.elevenLabs.textToSpeech(opts.text.trim().slice(0, 500), opts.voiceId, {
        apiKey: opts.apiKey,
        latencyMode: true,
        voiceCall: true,
        callSessionId: opts.callSessionId,
      });
      elevenlabsLatencyMs = Date.now() - started;
      const audioCacheKey = cached.audioCacheKey;
      this.phraseBuffers.set(audioCacheKey, {
        buffer,
        expiresAt: Date.now() + this.phraseTtlMs,
      });
      if (this.audioCache.isEnabled()) {
        void this.audioCache.setBuffer(audioCacheKey, buffer);
      }
      this.audioCache.logCacheEvent(false, audioCacheKey, 'miss', opts.callSessionId);
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
          audioCacheHit: false,
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
          audioCacheHit: false,
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
        audioCacheHit: false,
        ttsLatencyMs: elevenlabsLatencyMs,
      };
    } catch {
      return {
        playbackUrl: undefined,
        fromPhraseCache: false,
        audioCacheKey: cached.audioCacheKey,
        ttsGenerated: false,
        elevenlabsModel: modelId,
        audioServedFromCache: false,
        audioCacheHit: false,
      };
    }
  }

  private getMemoryBuffer(audioCacheKey: string): Buffer | null {
    const hit = this.phraseBuffers.get(audioCacheKey);
    if (!hit || hit.expiresAt <= Date.now()) return null;
    return hit.buffer;
  }

  private bufferToPlayback(publicOrigin: string, buffer: Buffer): string | undefined {
    const validation = validateTtsAudioBuffer(buffer);
    if (!validation.valid) return undefined;
    const token = this.ttsCache.put(buffer);
    return buildTtsPlaybackUrl(publicOrigin, token);
  }

  private logAudioCache(
    hit: boolean,
    audioCacheKey: string,
    layer: CacheLayer,
    callSessionId?: string,
  ): void {
    this.audioCache.logCacheEvent(hit, audioCacheKey, layer, callSessionId);
  }

  logWarmComplete(args: { agents: number; phrases: number; modelId: string }): void {
    this.audioCache.logWarmComplete(args);
  }
}
