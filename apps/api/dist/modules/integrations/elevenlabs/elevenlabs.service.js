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
var ElevenLabsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElevenLabsService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const elevenlabs_voice_model_util_1 = require("./elevenlabs-voice-model.util");
let ElevenLabsService = ElevenLabsService_1 = class ElevenLabsService {
    constructor(config) {
        this.config = config;
        this.logger = new common_1.Logger(ElevenLabsService_1.name);
    }
    async textToSpeech(text, voiceId, options) {
        const key = options?.apiKey?.trim();
        if (!key) {
            throw new common_1.BadRequestException('ElevenLabs API key is not configured for this agent. Add it in the agent form and save.');
        }
        const trimmed = text.trim().slice(0, 2500);
        if (!trimmed)
            throw new common_1.BadRequestException('Text is required');
        const vid = voiceId?.trim();
        if (!vid) {
            throw new common_1.BadRequestException('ElevenLabs voice ID is required on the agent. Save a single voice ID in agent settings.');
        }
        const isVoiceCall = options?.voiceCall === true || options?.latencyMode === true;
        const modelPick = (0, elevenlabs_voice_model_util_1.resolveElevenLabsVoiceModel)({
            agentModelId: options?.modelId,
            forceVoiceLatency: isVoiceCall,
            envLatencyModelId: this.config.get('ELEVENLABS_LATENCY_MODEL_ID'),
            envDefaultModelId: this.config.get('ELEVENLABS_MODEL_ID'),
        });
        (0, elevenlabs_voice_model_util_1.logElevenLabsModelSelected)(modelPick, {
            callSessionId: options?.callSessionId ?? null,
            voiceCall: isVoiceCall,
            latencyMode: options?.latencyMode === true,
        });
        const modelId = modelPick.selectedModel;
        const latencyMode = options?.latencyMode === true || isVoiceCall;
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`;
        const body = JSON.stringify({
            text: trimmed,
            model_id: modelId,
            voice_settings: latencyMode
                ? { stability: 0.35, similarity_boost: 0.75, style: 0, use_speaker_boost: false }
                : {
                    stability: 0.5,
                    similarity_boost: 0.8,
                    style: 0,
                    use_speaker_boost: true,
                },
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
exports.ElevenLabsService = ElevenLabsService = ElevenLabsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], ElevenLabsService);
//# sourceMappingURL=elevenlabs.service.js.map