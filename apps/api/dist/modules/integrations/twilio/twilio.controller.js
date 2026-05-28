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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var TwilioVoiceController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioVoiceController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
const twilio_signature_service_1 = require("./twilio-signature.service");
const twilio_webhook_service_1 = require("./twilio-webhook.service");
const twilio_status_callback_service_1 = require("./twilio-status-callback.service");
const config_1 = require("@nestjs/config");
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const roles_decorator_1 = require("../../../common/decorators/roles.decorator");
const safe_log_1 = require("../../../common/logging/safe-log");
const env_validation_1 = require("../../../common/env-validation");
const provider_env_fallback_util_1 = require("../../../common/provider-env-fallback.util");
const tenant_id_decorator_1 = require("../../../common/decorators/tenant-id.decorator");
const agents_service_1 = require("../../agents/agents.service");
const twilio_tts_cache_service_1 = require("./twilio-tts-cache.service");
const public_webhook_base_url_1 = require("../../../common/public-webhook-base-url");
const conversation_relay_twiml_1 = require("./twiml/conversation-relay.twiml");
const gather_speech_gate_util_1 = require("./gather-speech-gate.util");
const inboundSchema = zod_1.z.object({
    CallSid: zod_1.z.string().trim().min(1),
    From: zod_1.z.string().trim().min(3),
    To: zod_1.z.string().trim().min(3),
});
const gatherSchema = zod_1.z.object({
    CallSid: zod_1.z.string().trim().min(1),
    From: zod_1.z.string().trim().min(3),
    To: zod_1.z.string().trim().min(3),
    SpeechResult: zod_1.z.string().max(4000).optional(),
    StableSpeechResult: zod_1.z.string().max(4000).optional(),
    Confidence: zod_1.z.string().trim().optional(),
});
const statusSchema = zod_1.z.object({
    CallSid: zod_1.z.string().trim().min(1),
    CallStatus: zod_1.z.string().trim().min(1),
    CallDuration: zod_1.z.string().optional(),
    RecordingUrl: zod_1.z.string().optional(),
});
let TwilioVoiceController = TwilioVoiceController_1 = class TwilioVoiceController {
    constructor(signature, statusCallback, config, ttsCache, voiceWebhooks, agents) {
        this.signature = signature;
        this.statusCallback = statusCallback;
        this.config = config;
        this.ttsCache = ttsCache;
        this.voiceWebhooks = voiceWebhooks;
        this.agents = agents;
        this.logger = new common_1.Logger(TwilioVoiceController_1.name);
    }
    configCheck() {
        const baseUrlRaw = this.config.get('PUBLIC_WEBHOOK_BASE_URL') ?? '';
        const baseUrl = (0, public_webhook_base_url_1.normalizePublicWebhookBaseUrl)(baseUrlRaw);
        const validateSignatures = this.signature.isValidationEnabled();
        const envFallback = (0, provider_env_fallback_util_1.allowProviderEnvFallback)();
        const hasTwilioAuthToken = Boolean((this.config.get('TWILIO_AUTH_TOKEN') ?? '').trim()) || !envFallback;
        const hasElevenLabsApiKey = Boolean((this.config.get('ELEVENLABS_API_KEY') ?? '').trim()) || !envFallback;
        const webhookBaseValidation = (0, public_webhook_base_url_1.validatePublicWebhookBaseUrl)(baseUrlRaw);
        const hasPublicWebhookBaseUrl = Boolean(baseUrl);
        const isPublicHttps = webhookBaseValidation.ok;
        const requiredChecks = {
            publicWebhookBaseUrlSet: hasPublicWebhookBaseUrl,
            publicWebhookBaseUrlPublicHttps: isPublicHttps,
            twilioAuthTokenSet: hasTwilioAuthToken,
            elevenLabsApiKeySet: hasElevenLabsApiKey,
        };
        const missing = [];
        if (!requiredChecks.publicWebhookBaseUrlSet)
            missing.push('PUBLIC_WEBHOOK_BASE_URL');
        if (!requiredChecks.publicWebhookBaseUrlPublicHttps) {
            missing.push(`PUBLIC_WEBHOOK_BASE_URL must be public HTTPS (no localhost/ngrok/example/localtunnel). reason=${webhookBaseValidation.reason ?? 'invalid'}`);
        }
        if (validateSignatures &&
            envFallback &&
            !Boolean((this.config.get('TWILIO_AUTH_TOKEN') ?? '').trim())) {
            missing.push('TWILIO_AUTH_TOKEN (required when ALLOW_PROVIDER_ENV_FALLBACK=true and signature validation is enabled)');
        }
        const ready = missing.length === 0;
        return {
            status: ready ? 'ready' : 'not_ready',
            ready,
            signatureValidationEnabled: validateSignatures,
            callFlow: {
                incomingVoiceWebhookOwner: 'this_app',
                inboundCallMode: 'twilio-gather-mvp',
                llmProvider: 'openai',
                liveElevenLabsInboundSupported: hasElevenLabsApiKey,
            },
            checks: requiredChecks,
            missing,
            credentialMode: envFallback ? 'env_fallback_allowed' : 'per_agent_db_only',
            notes: [
                'Provider API keys (OpenAI, ElevenLabs, Twilio, Shopify, Resend) are loaded per agent from the database unless ALLOW_PROVIDER_ENV_FALLBACK=true.',
                'Configure your Twilio phone number to POST incoming calls to this app, not to the ElevenLabs native Twilio URL.',
                'Live inbound calls use Twilio webhooks plus Twilio Gather; OpenAI generates reply text.',
                'Inbound greeting uses Twilio <Say> only (fast webhook). After each user utterance, the app returns an instant <Say> then polls /api/twilio/voice/deferred-poll until OpenAI + optional ElevenLabs complete.',
                'Set PUBLIC_WEBHOOK_BASE_URL to your HTTPS origin only (no trailing /api).',
                'Set TWILIO_GATHER_HEARING_DEBUG=true to force the first Gather leg to Twilio <Say> only (no ElevenLabs greeting), timeout=12, speechTimeout=3, for speech-capture debugging.',
                'VOICE_DEFERRED_JOB_TIMEOUT_MS (default 55000, minimum 50000): background budget for OpenAI+Shopify+ElevenLabs; values below 50s are raised to avoid false timeouts when TTS alone takes ~10–15s.',
                'If logs show reason twilio_gather_hearing_debug on phrase_audio, set TWILIO_GATHER_HEARING_DEBUG=false for ElevenLabs on scripted prompts.',
            ],
            recommendedTwilioConfig: {
                incomingCallWebhook: `${baseUrl}/api/twilio/voice/inbound`,
                legacyIncomingCallWebhook: `${baseUrl}/api/twilio/inbound_call`,
                gatherWebhook: `${baseUrl}/api/twilio/voice/gather?callSessionId={sessionId}`,
                deferredPollWebhook: `${baseUrl}/api/twilio/voice/deferred-poll?callSessionId={sessionId}`,
                statusCallbackWebhook: `${baseUrl}/api/twilio/voice/status`,
                httpMethod: 'POST',
            },
        };
    }
    async liveCallReady(tenantId, agentId) {
        const twilio = this.configCheck();
        const env = (0, env_validation_1.validateProductionEnv)();
        const encryption = Boolean((this.config.get('ENCRYPTION_KEY') ?? '').trim());
        const jwt = Boolean((this.config.get('JWT_SECRET') ?? '').trim());
        let openAi = (0, provider_env_fallback_util_1.allowProviderEnvFallback)()
            ? Boolean((this.config.get('OPENAI_API_KEY') ?? '').trim())
            : true;
        let elevenLabs = (0, provider_env_fallback_util_1.allowProviderEnvFallback)()
            ? Boolean((this.config.get('ELEVENLABS_API_KEY') ?? '').trim())
            : true;
        let agentCredentialSummary = null;
        const trimmedAgentId = agentId?.trim();
        if (trimmedAgentId) {
            agentCredentialSummary = await this.agents.getCredentialSourcesSummary(tenantId, trimmedAgentId);
            openAi = agentCredentialSummary.openai.configured;
            elevenLabs = agentCredentialSummary.elevenlabs.configured;
        }
        const ready = twilio.ready && env.ok && openAi && elevenLabs && encryption && jwt;
        return {
            status: ready ? 'ready' : 'not_ready',
            ready,
            twilio,
            env,
            agentId: trimmedAgentId ?? null,
            agentCredentialSources: agentCredentialSummary,
            runtime: {
                inboundVoiceWebhookOwner: 'this_app',
                inboundCallMode: 'twilio-gather-mvp',
                llmProvider: 'openai',
                liveElevenLabsInboundSupported: elevenLabs,
            },
            checks: {
                openAiKeySet: openAi,
                elevenLabsKeySet: elevenLabs,
                encryptionKeySet: encryption,
                jwtSecretSet: jwt,
                agentIdProvided: Boolean(trimmedAgentId),
            },
            notes: trimmedAgentId
                ? []
                : [
                    'Pass ?agentId=<uuid> to validate per-agent OpenAI and ElevenLabs credentials from the agent form.',
                ],
        };
    }
    ttsAudio(token, res) {
        const trimmed = token?.trim() ?? '';
        const audio = this.ttsCache.take(trimmed);
        if (!audio)
            throw new common_1.BadRequestException('TTS audio is missing or expired');
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.tts_audio_served',
            tokenPrefix: trimmed.slice(0, 8),
            audioBytes: audio.length,
        }));
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.send(audio);
    }
    async inbound(req, res, body, signature) {
        console.log('Inbound webhook hit');
        try {
            const url = this.signature.resolveValidationUrl(req);
            if (this.signature.isValidationEnabled()) {
                if (!signature)
                    throw new common_1.BadRequestException('Missing Twilio signature');
                const valid = await this.signature.validateInbound(url, body, signature);
                if (!valid) {
                    this.logger.warn(JSON.stringify({
                        event: 'twilio.voice.signature_invalid',
                        route: 'inbound',
                        payload: (0, safe_log_1.redactSecrets)(body),
                    }));
                    throw new common_1.BadRequestException('Invalid Twilio signature');
                }
            }
            const parsedInbound = inboundSchema.safeParse(body);
            if (!parsedInbound.success) {
                throw new common_1.BadRequestException('Invalid Twilio inbound payload.');
            }
            const { twiml } = await this.voiceWebhooks.handleInboundVoice({
                CallSid: parsedInbound.data.CallSid,
                From: parsedInbound.data.From,
                To: parsedInbound.data.To,
            });
            res.type('text/xml; charset=utf-8').send(twiml);
        }
        catch (error) {
            console.error('Twilio inbound error:', error);
            throw error;
        }
    }
    async inboundLegacy(req, res, body, signature) {
        console.log('Inbound webhook hit (legacy inbound_call)');
        const url = this.signature.resolveValidationUrl(req);
        if (this.signature.isValidationEnabled()) {
            if (!signature)
                throw new common_1.BadRequestException('Missing Twilio signature');
            const valid = await this.signature.validateInbound(url, body, signature);
            if (!valid) {
                this.logger.warn(JSON.stringify({
                    event: 'twilio.voice.signature_invalid',
                    route: 'inbound_legacy',
                    payload: (0, safe_log_1.redactSecrets)(body),
                }));
                throw new common_1.BadRequestException('Invalid Twilio signature');
            }
        }
        const parsedInbound = inboundSchema.safeParse(body);
        if (!parsedInbound.success) {
            throw new common_1.BadRequestException('Invalid Twilio inbound payload.');
        }
        const { twiml } = await this.voiceWebhooks.handleInboundVoice({
            CallSid: parsedInbound.data.CallSid,
            From: parsedInbound.data.From,
            To: parsedInbound.data.To,
        });
        res.type('text/xml; charset=utf-8').send(twiml);
    }
    async gather(req, res, body, callSessionId, signature) {
        console.log('Gather webhook hit');
        try {
            const url = this.signature.resolveValidationUrl(req);
            if (this.signature.isValidationEnabled()) {
                if (!signature)
                    throw new common_1.BadRequestException('Missing Twilio signature');
                const valid = await this.signature.validateInbound(url, body, signature);
                if (!valid) {
                    this.logger.warn(JSON.stringify({
                        event: 'twilio.voice.signature_invalid',
                        route: 'gather',
                        payload: (0, safe_log_1.redactSecrets)(body),
                    }));
                    throw new common_1.BadRequestException('Invalid Twilio signature');
                }
            }
            const parsedGather = gatherSchema.safeParse(body);
            if (!parsedGather.success) {
                throw new common_1.BadRequestException('Invalid Twilio gather payload.');
            }
            const g = parsedGather.data;
            const gate = (0, gather_speech_gate_util_1.computeGatherSpeechGate)({
                SpeechResult: g.SpeechResult,
                StableSpeechResult: g.StableSpeechResult,
                Confidence: g.Confidence,
            });
            const speechCaptured = Boolean((g.SpeechResult ?? '').trim() || (g.StableSpeechResult ?? '').trim());
            const maskPhoneTail = (value) => {
                const digits = value.replace(/\D/g, '');
                if (digits.length < 4)
                    return '***';
                return `****${digits.slice(-4)}`;
            };
            const fullGatherBody = { ...body };
            if (fullGatherBody.From)
                fullGatherBody.From = maskPhoneTail(fullGatherBody.From);
            if (fullGatherBody.To)
                fullGatherBody.To = maskPhoneTail(fullGatherBody.To);
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.gather_handler_proof',
                route: '/api/twilio/voice/gather',
                fullGatherBody,
                SpeechResult: g.SpeechResult ?? '',
                StableSpeechResult: g.StableSpeechResult ?? '',
                Confidence: g.Confidence ?? '',
                hasUsableSpeech: gate.hasUsableSpeech,
                willCallVoiceRuntime: gate.willCallVoiceRuntime,
                deferredVoiceJobQueued: gate.willCallVoiceRuntime,
                speechCapturedFromTwilio: speechCaptured,
                callSessionIdQuery: callSessionId?.trim() ?? null,
                CallSid: g.CallSid,
                ...(speechCaptured
                    ? {}
                    : {
                        diagnosis: 'OpenAI key is not the cause. Twilio did not capture speech.',
                    }),
            }));
            const { twiml } = await this.voiceWebhooks.handleGatherMvpVoice({
                CallSid: g.CallSid,
                From: g.From,
                To: g.To,
                SpeechResult: g.SpeechResult,
                StableSpeechResult: g.StableSpeechResult,
                Confidence: g.Confidence,
                callSessionId: callSessionId?.trim() || undefined,
            });
            res.type('text/xml; charset=utf-8').send(twiml);
        }
        catch (error) {
            console.error(error);
            if (error instanceof common_1.BadRequestException)
                throw error;
            const twiml = (0, conversation_relay_twiml_1.buildFallbackTwiML)('Sorry, something went wrong. Please try your call again.');
            res.type('text/xml; charset=utf-8').send(twiml);
        }
    }
    async deferredPoll(req, res, body, callSessionId, signature) {
        try {
            const url = this.signature.resolveValidationUrl(req);
            if (this.signature.isValidationEnabled()) {
                if (!signature)
                    throw new common_1.BadRequestException('Missing Twilio signature');
                const valid = await this.signature.validateInbound(url, body, signature);
                if (!valid) {
                    this.logger.warn(JSON.stringify({
                        event: 'twilio.voice.signature_invalid',
                        route: 'deferred-poll',
                        payload: (0, safe_log_1.redactSecrets)(body),
                    }));
                    throw new common_1.BadRequestException('Invalid Twilio signature');
                }
            }
            const parsed = gatherSchema.safeParse(body);
            if (!parsed.success) {
                throw new common_1.BadRequestException('Invalid Twilio deferred-poll payload.');
            }
            const g = parsed.data;
            const payload = {
                CallSid: g.CallSid,
                From: g.From,
                To: g.To,
                callSessionId: callSessionId?.trim() || undefined,
            };
            const { twiml } = await this.voiceWebhooks.handleDeferredVoicePoll(payload);
            res.type('text/xml; charset=utf-8').send(twiml);
        }
        catch (error) {
            console.error(error);
            if (error instanceof common_1.BadRequestException)
                throw error;
            const twiml = (0, conversation_relay_twiml_1.buildFallbackTwiML)('Sorry, something went wrong. Please try your call again.');
            res.type('text/xml; charset=utf-8').send(twiml);
        }
    }
    async status(req, res, body, signature) {
        try {
            const url = this.signature.resolveValidationUrl(req);
            if (this.signature.isValidationEnabled()) {
                if (!signature) {
                    this.logger.warn(JSON.stringify({ event: 'twilio.voice.status_missing_signature' }));
                    return res.status(200).send('OK');
                }
                const valid = await this.signature.validateInbound(url, body, signature);
                if (!valid) {
                    this.logger.warn(JSON.stringify({
                        event: 'twilio.voice.signature_invalid',
                        route: 'status',
                        payload: (0, safe_log_1.redactSecrets)(body),
                    }));
                    return res.status(200).send('OK');
                }
            }
            const parsedStatus = statusSchema.safeParse(body);
            if (!parsedStatus.success) {
                console.error('Twilio status error: invalid payload', parsedStatus.error.flatten());
                return res.status(200).send('OK');
            }
            const parsed = parsedStatus.data;
            await this.statusCallback.handleStatus({
                CallSid: parsed.CallSid,
                CallStatus: parsed.CallStatus,
                CallDuration: parsed.CallDuration,
                RecordingUrl: parsed.RecordingUrl,
            });
        }
        catch (error) {
            console.error('Twilio status error:', error);
        }
        return res.status(200).send('OK');
    }
};
exports.TwilioVoiceController = TwilioVoiceController;
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, throttler_1.Throttle)({ default: { limit: 20, ttl: 60_000 } }),
    (0, common_1.Get)('config-check'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], TwilioVoiceController.prototype, "configCheck", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Get)('live-call-ready'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)('agentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], TwilioVoiceController.prototype, "liveCallReady", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Get)('voice/tts/:token'),
    __param(0, (0, common_1.Param)('token')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], TwilioVoiceController.prototype, "ttsAudio", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Post)('voice/inbound'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Headers)('x-twilio-signature')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, String]),
    __metadata("design:returntype", Promise)
], TwilioVoiceController.prototype, "inbound", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Post)('inbound_call'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Headers)('x-twilio-signature')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, String]),
    __metadata("design:returntype", Promise)
], TwilioVoiceController.prototype, "inboundLegacy", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Post)('voice/gather'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Query)('callSessionId')),
    __param(4, (0, common_1.Headers)('x-twilio-signature')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, String]),
    __metadata("design:returntype", Promise)
], TwilioVoiceController.prototype, "gather", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Post)('voice/deferred-poll'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Query)('callSessionId')),
    __param(4, (0, common_1.Headers)('x-twilio-signature')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, String]),
    __metadata("design:returntype", Promise)
], TwilioVoiceController.prototype, "deferredPoll", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Post)('voice/status'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Headers)('x-twilio-signature')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, String]),
    __metadata("design:returntype", Promise)
], TwilioVoiceController.prototype, "status", null);
exports.TwilioVoiceController = TwilioVoiceController = TwilioVoiceController_1 = __decorate([
    (0, common_1.Controller)('twilio'),
    __metadata("design:paramtypes", [twilio_signature_service_1.TwilioSignatureService,
        twilio_status_callback_service_1.TwilioStatusCallbackService,
        config_1.ConfigService,
        twilio_tts_cache_service_1.TwilioTtsCacheService,
        twilio_webhook_service_1.TwilioWebhookService,
        agents_service_1.AgentsService])
], TwilioVoiceController);
//# sourceMappingURL=twilio.controller.js.map