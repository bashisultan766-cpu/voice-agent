"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var VoicePromptAudioService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoicePromptAudioService = exports.VOICE_PRELOADED_PHRASES = exports.VOICE_PRODUCTION_PREWARM_PHRASES = void 0;
const common_1 = require("@nestjs/common");
const elevenlabs_service_1 = require("../elevenlabs/elevenlabs.service");
const elevenlabs_voice_model_util_1 = require("../elevenlabs/elevenlabs-voice-model.util");
const twilio_tts_cache_service_1 = require("./twilio-tts-cache.service");
const voice_audio_cache_service_1 = require("./voice-audio-cache.service");
const voice_elevenlabs_playback_util_1 = require("./voice-elevenlabs-playback.util");
const instant_reply_util_1 = require("../../calls/runtime/instant-reply.util");
const voice_search_filler_util_1 = require("../../search/voice/voice-search-filler.util");
exports.VOICE_PRODUCTION_PREWARM_PHRASES = [
    instant_reply_util_1.VOICE_CACHED_PHRASES.greeting,
    instant_reply_util_1.VOICE_CACHED_PHRASES.salamShort,
    instant_reply_util_1.VOICE_CACHED_PHRASES.searchAckShort,
    instant_reply_util_1.VOICE_CACHED_PHRASES.searchAck,
    instant_reply_util_1.VOICE_CACHED_PHRASES.checkoutIntro,
    instant_reply_util_1.VOICE_CACHED_PHRASES.emailPrompt,
    instant_reply_util_1.VOICE_CACHED_PHRASES.emailSpell,
    instant_reply_util_1.VOICE_CACHED_PHRASES.paymentLinkSent,
    instant_reply_util_1.VOICE_CACHED_PHRASES.thanks,
];
exports.VOICE_PRELOADED_PHRASES = [
    ...exports.VOICE_PRODUCTION_PREWARM_PHRASES,
    instant_reply_util_1.VOICE_CACHED_PHRASES.salam,
    instant_reply_util_1.VOICE_CACHED_PHRASES.howAreYou,
    instant_reply_util_1.VOICE_CACHED_PHRASES.yes,
    instant_reply_util_1.VOICE_CACHED_PHRASES.no,
    instant_reply_util_1.VOICE_CACHED_PHRASES.okay,
    instant_reply_util_1.VOICE_CACHED_PHRASES.goodbye,
    instant_reply_util_1.VOICE_CACHED_PHRASES.namaste,
    instant_reply_util_1.VOICE_CACHED_PHRASES.productCorrection,
    instant_reply_util_1.VOICE_CACHED_PHRASES.emailConfirm,
    instant_reply_util_1.VOICE_CACHED_PHRASES.thankYouOrder,
    instant_reply_util_1.VOICE_CACHED_PHRASES.repeat,
    instant_reply_util_1.VOICE_CACHED_PHRASES.speakEnglish,
    instant_reply_util_1.VOICE_CACHED_PHRASES.oneMoment,
    instant_reply_util_1.VOICE_CACHED_PHRASES.checking,
    instant_reply_util_1.VOICE_CACHED_PHRASES.verifying,
    ...voice_search_filler_util_1.SEARCH_FILLERS,
    ...voice_search_filler_util_1.GENERIC_FILLERS,
];
let VoicePromptAudioService = VoicePromptAudioService_1 = class VoicePromptAudioService {
    constructor(elevenLabs, ttsCache, audioCache) {
        this.elevenLabs = elevenLabs;
        this.ttsCache = ttsCache;
        this.audioCache = audioCache;
        this.logger = new common_1.Logger(VoicePromptAudioService_1.name);
        this.phraseBuffers = new Map();
        this.phraseTtlMs = 7 * 24 * 60 * 60 * 1000;
    }
    audioCacheKey(voiceId, modelId, text) {
        return this.cacheKey(voiceId, modelId, text);
    }
    hasCachedPhrase(voiceId, modelId, text) {
        const k = this.cacheKey(voiceId, modelId, text);
        const hit = this.phraseBuffers.get(k);
        return Boolean(hit && hit.expiresAt > Date.now());
    }
    resolveLatencyModelId(_agentModelId) {
        return (0, elevenlabs_voice_model_util_1.resolveElevenLabsVoiceModel)({ forceVoiceLatency: true }).selectedModel;
    }
    async warmPreloadedPhrases(opts) {
        const vid = opts.voiceId?.trim();
        if (!vid)
            return { warmed: 0, modelId: this.resolveLatencyModelId(null) };
        const modelId = this.resolveLatencyModelId(null);
        let warmed = 0;
        for (const text of exports.VOICE_PRELOADED_PHRASES) {
            const ok = await this.ensurePhraseBuffer(text, vid, opts.apiKey, modelId);
            if (ok)
                warmed += 1;
        }
        return { warmed, modelId };
    }
    async ensurePhraseBuffer(text, voiceId, apiKey, modelId) {
        const k = this.cacheKey(voiceId, modelId, text);
        const mem = this.phraseBuffers.get(k);
        if (mem && mem.expiresAt > Date.now())
            return true;
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
    cacheKey(voiceId, modelId, text) {
        return this.audioCache.audioHash(voiceId, modelId, text);
    }
    async resolveCachedPhrasePlaybackUrl(publicOrigin, opts) {
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
            cacheLayer: 'miss',
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
    async createPhrasePlaybackUrl(publicOrigin, opts) {
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
            const validation = (0, voice_elevenlabs_playback_util_1.validateTtsAudioBuffer)(buffer);
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
            this.logger.log(JSON.stringify({
                event: 'voice.tts.generated',
                ttsLatencyMs: elevenlabsLatencyMs,
                elevenlabsModel: modelId,
                audioServedFromCache: false,
                audioCacheHit: false,
                callSessionId: opts.callSessionId ?? null,
            }));
            return {
                playbackUrl: (0, voice_elevenlabs_playback_util_1.buildTtsPlaybackUrl)(publicOrigin, token),
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
        catch {
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
    getMemoryBuffer(audioCacheKey) {
        const hit = this.phraseBuffers.get(audioCacheKey);
        if (!hit || hit.expiresAt <= Date.now())
            return null;
        return hit.buffer;
    }
    bufferToPlayback(publicOrigin, buffer) {
        const validation = (0, voice_elevenlabs_playback_util_1.validateTtsAudioBuffer)(buffer);
        if (!validation.valid)
            return undefined;
        const token = this.ttsCache.put(buffer);
        return (0, voice_elevenlabs_playback_util_1.buildTtsPlaybackUrl)(publicOrigin, token);
    }
    logAudioCache(hit, audioCacheKey, layer, callSessionId) {
        this.audioCache.logCacheEvent(hit, audioCacheKey, layer, callSessionId);
    }
    logWarmComplete(args) {
        this.audioCache.logWarmComplete(args);
    }
};
exports.VoicePromptAudioService = VoicePromptAudioService;
exports.VoicePromptAudioService = VoicePromptAudioService = VoicePromptAudioService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [elevenlabs_service_1.ElevenLabsService,
        twilio_tts_cache_service_1.TwilioTtsCacheService,
        voice_audio_cache_service_1.VoiceAudioCacheService])
], VoicePromptAudioService);
//# sourceMappingURL=voice-prompt-audio.service.js.map