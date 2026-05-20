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
exports.ElevenLabsService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
let ElevenLabsService = class ElevenLabsService {
    constructor(config) {
        this.config = config;
    }
    async textToSpeech(text, voiceId, options) {
        const key = options?.apiKey?.trim() || this.config.get('ELEVENLABS_API_KEY');
        if (!key?.trim()) {
            throw new common_1.BadRequestException('ELEVENLABS_API_KEY is not configured');
        }
        const trimmed = text.trim().slice(0, 2500);
        if (!trimmed)
            throw new common_1.BadRequestException('Text is required');
        const vid = voiceId?.trim() ||
            this.config.get('ELEVENLABS_DEFAULT_VOICE_ID')?.trim() ||
            '21m00Tcm4TlvDq8ikWAM';
        const modelId = options?.modelId?.trim() ||
            this.config.get('ELEVENLABS_MODEL_ID')?.trim() ||
            'eleven_multilingual_v2';
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`;
        const body = JSON.stringify({
            text: trimmed,
            model_id: modelId,
            ...(options?.styleNotes?.trim()
                ? {
                    voice_settings: {
                        style: 0.45,
                    },
                }
                : {}),
        });
        let lastNetworkError;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'xi-api-key': key,
                        'Content-Type': 'application/json',
                        Accept: 'audio/mpeg',
                    },
                    body,
                });
                if (!res.ok) {
                    const errText = await res.text();
                    throw new common_1.BadRequestException(`ElevenLabs error ${res.status}: ${errText.slice(0, 200)}`);
                }
                return Buffer.from(await res.arrayBuffer());
            }
            catch (err) {
                if (err instanceof common_1.BadRequestException)
                    throw err;
                lastNetworkError = err;
                if (attempt < 2) {
                    await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
                }
            }
        }
        throw lastNetworkError instanceof Error ? lastNetworkError : new Error('ElevenLabs fetch failed after retries');
    }
};
exports.ElevenLabsService = ElevenLabsService;
exports.ElevenLabsService = ElevenLabsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], ElevenLabsService);
//# sourceMappingURL=elevenlabs.service.js.map