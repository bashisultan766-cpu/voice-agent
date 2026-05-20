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
var ElevenLabsConnectionTestService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElevenLabsConnectionTestService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
let ElevenLabsConnectionTestService = ElevenLabsConnectionTestService_1 = class ElevenLabsConnectionTestService {
    constructor(config) {
        this.config = config;
        this.log = new common_1.Logger(ElevenLabsConnectionTestService_1.name);
    }
    async parseErrorText(res) {
        return (await res.text().catch(() => '')).slice(0, 180);
    }
    hasMissingPermission(errorText, permission) {
        const lower = errorText.toLowerCase();
        return lower.includes('missing_permissions') && lower.includes(permission.toLowerCase());
    }
    looksLikeInvalidApiKey(errorText) {
        const lower = errorText.toLowerCase();
        return (lower.includes('invalid_api_key') ||
            lower.includes('invalid api key') ||
            lower.includes('unauthorized') ||
            lower.includes('api key is invalid'));
    }
    async canSynthesizeTinyTest(apiKey, voiceId, operation, tenantId) {
        const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                Accept: 'audio/mpeg',
            },
            body: JSON.stringify({
                text: 'Test',
                model_id: 'eleven_multilingual_v2',
            }),
        });
        this.logDebug(operation, tenantId, {
            endpoint,
            responseStatus: res.status,
        });
        if (res.ok) {
            await res.arrayBuffer().catch(() => undefined);
            return { ok: true };
        }
        const errText = await this.parseErrorText(res);
        if (res.status === 401 || res.status === 403) {
            if (this.hasMissingPermission(errText, 'user_read')) {
                return {
                    ok: true,
                    warning: 'Key is valid for voice usage but does not include user_read permission.',
                };
            }
            return { ok: false, error: `ElevenLabs TTS validation failed (${res.status}): ${errText}` };
        }
        if (res.status === 404) {
            return { ok: false, error: `Voice ID "${voiceId}" was not found in this ElevenLabs workspace.` };
        }
        return { ok: false, error: `ElevenLabs TTS validation failed (${res.status}): ${errText}` };
    }
    logDebug(operation, tenantId, payload) {
        this.log.log(JSON.stringify({
            event: 'elevenlabs_connection_debug',
            operation,
            provider: 'elevenlabs',
            ...(tenantId ? { tenantId } : {}),
            ...payload,
        }));
    }
    validateRequired(config) {
        const key = config.elevenlabsApiKey?.trim();
        if (!key)
            return 'ElevenLabs API key is required to test the connection.';
        return null;
    }
    async testConnection(config) {
        const validationError = this.validateRequired(config);
        if (validationError)
            return { success: false, message: validationError };
        const apiKey = config.elevenlabsApiKey.trim();
        const defaultVoiceId = this.config.get('ELEVENLABS_DEFAULT_VOICE_ID')?.trim();
        const voiceId = config.voiceId?.trim() || defaultVoiceId || undefined;
        const operation = config.source ?? 'test';
        const warnings = [];
        this.logDebug(operation, config.tenantId, {
            hasApiKey: true,
            apiKeyLength: apiKey.length,
            hasVoiceId: Boolean(voiceId),
            voiceIdLength: voiceId?.length ?? 0,
        });
        try {
            const modelsEndpoint = 'https://api.elevenlabs.io/v1/models';
            const modelsRes = await fetch(modelsEndpoint, {
                method: 'GET',
                headers: {
                    'xi-api-key': apiKey,
                    Accept: 'application/json',
                },
            });
            this.logDebug(operation, config.tenantId, {
                endpoint: modelsEndpoint,
                responseStatus: modelsRes.status,
            });
            let keyValid = false;
            let hasUserReadWarning = false;
            let explicitInvalidKey = false;
            if (modelsRes.ok) {
                keyValid = true;
            }
            else {
                const errText = await this.parseErrorText(modelsRes);
                if (this.hasMissingPermission(errText, 'user_read')) {
                    hasUserReadWarning = true;
                }
                else if (this.looksLikeInvalidApiKey(errText)) {
                    explicitInvalidKey = true;
                }
                else if (modelsRes.status !== 401 &&
                    modelsRes.status !== 403 &&
                    !this.hasMissingPermission(errText, 'models_read')) {
                    return {
                        success: false,
                        message: `ElevenLabs model check failed (${modelsRes.status}): ${errText}`,
                    };
                }
            }
            const voicesEndpoint = 'https://api.elevenlabs.io/v1/voices';
            const voicesRes = await fetch(voicesEndpoint, {
                method: 'GET',
                headers: {
                    'xi-api-key': apiKey,
                    Accept: 'application/json',
                },
            });
            this.logDebug(operation, config.tenantId, {
                endpoint: voicesEndpoint,
                responseStatus: voicesRes.status,
            });
            if (voicesRes.ok) {
                keyValid = true;
            }
            else {
                const errText = await this.parseErrorText(voicesRes);
                if (this.hasMissingPermission(errText, 'user_read')) {
                    hasUserReadWarning = true;
                }
                else if (this.looksLikeInvalidApiKey(errText)) {
                    explicitInvalidKey = true;
                }
                else if (voicesRes.status !== 401 &&
                    voicesRes.status !== 403 &&
                    !this.hasMissingPermission(errText, 'voices_read')) {
                    return {
                        success: false,
                        message: `ElevenLabs voices check failed (${voicesRes.status}): ${errText}`,
                    };
                }
            }
            if (voiceId) {
                const voiceEndpoint = `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`;
                const voiceRes = await fetch(voiceEndpoint, {
                    method: 'GET',
                    headers: {
                        'xi-api-key': apiKey,
                        Accept: 'application/json',
                    },
                });
                this.logDebug(operation, config.tenantId, {
                    endpoint: voiceEndpoint,
                    responseStatus: voiceRes.status,
                });
                if (voiceRes.ok) {
                    keyValid = true;
                }
                else {
                    const errText = await this.parseErrorText(voiceRes);
                    if (voiceRes.status === 404) {
                        return { success: false, message: `Voice ID "${voiceId}" was not found in this ElevenLabs workspace.` };
                    }
                    if (this.hasMissingPermission(errText, 'user_read')) {
                        hasUserReadWarning = true;
                    }
                    else if (this.looksLikeInvalidApiKey(errText)) {
                        explicitInvalidKey = true;
                    }
                    else if (voiceRes.status !== 401 &&
                        voiceRes.status !== 403 &&
                        !this.hasMissingPermission(errText, 'voices_read')) {
                        return { success: false, message: `ElevenLabs voice check failed (${voiceRes.status}): ${errText}` };
                    }
                }
            }
            if (operation === 'test' && voiceId) {
                const ttsCheck = await this.canSynthesizeTinyTest(apiKey, voiceId, operation, config.tenantId);
                if (ttsCheck.ok) {
                    keyValid = true;
                    if (ttsCheck.warning)
                        warnings.push(ttsCheck.warning);
                }
                else if (ttsCheck.error) {
                    return { success: false, message: ttsCheck.error };
                }
            }
            if (!keyValid) {
                if (operation === 'save' && !explicitInvalidKey) {
                    warnings.push('Could not verify models/voices listing permissions during save. Use Test to run a tiny TTS validation.');
                    if (hasUserReadWarning) {
                        warnings.push('Key is valid for voice usage but does not include user_read permission.');
                    }
                    return {
                        success: true,
                        message: 'ElevenLabs connection saved with limited permission visibility.',
                        warnings,
                    };
                }
                return {
                    success: false,
                    message: 'ElevenLabs key could not be validated for voice usage. Ensure models_read, voices_read, or TTS access is granted.',
                };
            }
            if (hasUserReadWarning) {
                warnings.push('Key is valid for voice usage but does not include user_read permission.');
            }
            return {
                success: true,
                message: 'ElevenLabs connection successful.',
                ...(warnings.length ? { warnings } : {}),
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, message: `ElevenLabs connection failed: ${message}` };
        }
    }
};
exports.ElevenLabsConnectionTestService = ElevenLabsConnectionTestService;
exports.ElevenLabsConnectionTestService = ElevenLabsConnectionTestService = ElevenLabsConnectionTestService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], ElevenLabsConnectionTestService);
//# sourceMappingURL=elevenlabs-connection-test.service.js.map