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
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoicePromptAudioService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const elevenlabs_service_1 = require("../elevenlabs/elevenlabs.service");
const twilio_tts_cache_service_1 = require("./twilio-tts-cache.service");
const voice_elevenlabs_playback_util_1 = require("./voice-elevenlabs-playback.util");
let VoicePromptAudioService = class VoicePromptAudioService {
    constructor(elevenLabs, ttsCache) {
        this.elevenLabs = elevenLabs;
        this.ttsCache = ttsCache;
        this.phraseBuffers = new Map();
        this.phraseTtlMs = 24 * 60 * 60 * 1000;
    }
    cacheKey(voiceId, modelId, text) {
        const t = text.trim().slice(0, 2000);
        return (0, crypto_1.createHash)('sha256').update(`${voiceId}\0${modelId}\0${t}`, 'utf8').digest('hex');
    }
    async createPhrasePlaybackUrl(publicOrigin, opts) {
        const modelId = opts.modelId?.trim() || 'eleven_multilingual_v2';
        const vid = opts.voiceId.trim();
        const text = opts.text.trim().slice(0, 500);
        if (!text || !vid || !/^https:\/\//i.test(publicOrigin)) {
            return { playbackUrl: undefined, fromPhraseCache: false };
        }
        const k = this.cacheKey(vid, modelId, text);
        const now = Date.now();
        let buffer;
        let fromPhraseCache = false;
        const hit = this.phraseBuffers.get(k);
        if (hit && hit.expiresAt > now) {
            buffer = hit.buffer;
            fromPhraseCache = true;
        }
        else {
            try {
                buffer = await this.elevenLabs.textToSpeech(text, vid, {
                    apiKey: opts.apiKey,
                    modelId,
                });
                this.phraseBuffers.set(k, { buffer, expiresAt: now + this.phraseTtlMs });
            }
            catch {
                return { playbackUrl: undefined, fromPhraseCache: false };
            }
        }
        const validation = (0, voice_elevenlabs_playback_util_1.validateTtsAudioBuffer)(buffer);
        if (!validation.valid) {
            return { playbackUrl: undefined, fromPhraseCache };
        }
        const token = this.ttsCache.put(buffer);
        const playbackUrl = (0, voice_elevenlabs_playback_util_1.buildTtsPlaybackUrl)(publicOrigin, token);
        return { playbackUrl, fromPhraseCache };
    }
};
exports.VoicePromptAudioService = VoicePromptAudioService;
exports.VoicePromptAudioService = VoicePromptAudioService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [elevenlabs_service_1.ElevenLabsService,
        twilio_tts_cache_service_1.TwilioTtsCacheService])
], VoicePromptAudioService);
//# sourceMappingURL=voice-prompt-audio.service.js.map