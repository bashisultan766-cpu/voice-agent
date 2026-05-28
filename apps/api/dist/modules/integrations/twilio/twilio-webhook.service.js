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
var TwilioWebhookService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioWebhookService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const config_1 = require("@nestjs/config");
const agent_resolution_service_1 = require("./agent-resolution.service");
const calls_service_1 = require("../../calls/calls.service");
const call_events_service_1 = require("../../analytics/call-events.service");
const client_1 = require("@prisma/client");
const conversation_relay_twiml_1 = require("./twiml/conversation-relay.twiml");
const gather_mvp_twiml_1 = require("./twiml/gather-mvp.twiml");
const voice_runtime_service_1 = require("../../calls/runtime/voice-runtime.service");
const session_context_service_1 = require("../../calls/runtime/session-context.service");
const transcript_buffer_service_1 = require("../../calls/runtime/transcript-buffer.service");
const elevenlabs_service_1 = require("../elevenlabs/elevenlabs.service");
const twilio_tts_cache_service_1 = require("./twilio-tts-cache.service");
const public_webhook_base_url_1 = require("../../../common/public-webhook-base-url");
const language_intelligence_util_1 = require("../../calls/runtime/language-intelligence.util");
const normalize_phone_1 = require("./utils/normalize-phone");
const prisma_service_1 = require("../../../database/prisma.service");
const encryption_service_1 = require("../../../common/encryption.service");
const credential_resolver_util_1 = require("../../../common/credential-resolver.util");
const voice_config_resolution_util_1 = require("../../calls/runtime/voice-config-resolution.util");
const api_key_fingerprint_1 = require("../../../common/logging/api-key-fingerprint");
const provider_env_slice_util_1 = require("../../../common/provider-env-slice.util");
const voice_reply_tts_shorten_util_1 = require("./voice-reply-tts-shorten.util");
const voice_prompt_audio_service_1 = require("./voice-prompt-audio.service");
const user_intent_classifier_util_1 = require("../../calls/runtime/user-intent-classifier.util");
const instant_acknowledgement_util_1 = require("./instant-acknowledgement.util");
const media_stream_twiml_1 = require("./twiml/media-stream.twiml");
const voice_stream_metrics_service_1 = require("../../calls/runtime/voice-stream-metrics.service");
const voice_cost_analytics_service_1 = require("../../calls/runtime/voice-cost-analytics.service");
const voice_streaming_session_service_1 = require("../../calls/runtime/voice-streaming-session.service");
const elevenlabs_streaming_service_1 = require("../elevenlabs/elevenlabs-streaming.service");
const voice_response_chunker_util_1 = require("../../calls/runtime/voice-response-chunker.util");
const streaming_fallback_util_1 = require("../../calls/runtime/streaming-fallback.util");
function maskPhoneForLog(value) {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 4)
        return '***';
    return `****${digits.slice(-4)}`;
}
const VOICE_DEFERRED_JOB_TIMEOUT_MS_MIN = 50_000;
let TwilioWebhookService = TwilioWebhookService_1 = class TwilioWebhookService {
    constructor(config, agentResolution, callsService, callEvents, voiceRuntime, sessionContext, transcriptBuffer, elevenLabs, ttsCache, voicePromptAudio, prisma, encryption, streamMetrics, voiceCost, streamingSession, elevenStreaming) {
        this.config = config;
        this.agentResolution = agentResolution;
        this.callsService = callsService;
        this.callEvents = callEvents;
        this.voiceRuntime = voiceRuntime;
        this.sessionContext = sessionContext;
        this.transcriptBuffer = transcriptBuffer;
        this.elevenLabs = elevenLabs;
        this.ttsCache = ttsCache;
        this.voicePromptAudio = voicePromptAudio;
        this.prisma = prisma;
        this.encryption = encryption;
        this.streamMetrics = streamMetrics;
        this.voiceCost = voiceCost;
        this.streamingSession = streamingSession;
        this.elevenStreaming = elevenStreaming;
        this.logger = new common_1.Logger(TwilioWebhookService_1.name);
        const validated = (0, public_webhook_base_url_1.validatePublicWebhookBaseUrl)(this.config.get('PUBLIC_WEBHOOK_BASE_URL'));
        if (!validated.ok) {
            const reason = validated.reason ?? 'invalid';
            throw new Error(`Invalid PUBLIC_WEBHOOK_BASE_URL (${reason}). Set a public HTTPS origin (no localhost/ngrok/example/localtunnel).`);
        }
        this.publicBaseUrl = validated.normalized;
    }
    onModuleInit() {
        const gatherDebug = this.isGatherHearingDebugMode();
        const forceEl = this.isForceElevenLabsOnly();
        if (gatherDebug) {
            this.logger.warn(JSON.stringify({
                event: 'twilio.voice.config_warning',
                TWILIO_GATHER_HEARING_DEBUG: true,
                FORCE_ELEVENLABS_ONLY: forceEl,
                effect: forceEl
                    ? 'TWILIO_GATHER_HEARING_DEBUG is set, but FORCE_ELEVENLABS_ONLY wins: short scripted prompts still use ElevenLabs <Play> (Twilio <Say> is only used if ElevenLabs fails, voice ID is missing, or PUBLIC_WEBHOOK_BASE_URL is not HTTPS).'
                    : 'TWILIO_GATHER_HEARING_DEBUG disables ElevenLabs for short scripted prompts; those lines use Twilio <Say> instead. This helps STT debugging but sounds like a second voice in production—unset it or set FORCE_ELEVENLABS_ONLY=true to keep ElevenLabs.',
            }));
        }
        this.logger.log(JSON.stringify({
            event: 'voice.public_base_url',
            value: this.publicBaseUrl,
        }));
    }
    getPublicBaseUrl() {
        return this.publicBaseUrl;
    }
    getVoiceGreetingMaxMs() {
        const raw = `${this.config.get('VOICE_GREETING_MAX_MS') ?? process.env.VOICE_GREETING_MAX_MS ?? '1200'}`.trim();
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0)
            return 1200;
        return Math.max(400, Math.min(3000, Math.trunc(n)));
    }
    estimateGreetingAudioMs(text) {
        const chars = text.trim().length;
        if (chars <= 0)
            return 0;
        return Math.max(350, Math.min(7000, Math.trunc(chars * 55)));
    }
    shortenGreetingForCapture(text, maxMs) {
        const t = text.trim();
        if (!t)
            return 'Hello, how can I help?';
        if (this.estimateGreetingAudioMs(t) <= maxMs)
            return t;
        const sentence = t.split(/[.!?]/).map((s) => s.trim()).filter(Boolean)[0] ?? t;
        const compact = sentence.split(/\s+/).slice(0, 8).join(' ');
        return compact.length > 0 ? compact : 'Hello, how can I help?';
    }
    isGatherHearingDebugMode() {
        const v = `${this.config.get('TWILIO_GATHER_HEARING_DEBUG') ?? process.env.TWILIO_GATHER_HEARING_DEBUG ?? ''}`.trim();
        return v === '1' || v.toLowerCase() === 'true';
    }
    isForceElevenLabsOnly() {
        const v = `${this.config.get('FORCE_ELEVENLABS_ONLY') ?? process.env.FORCE_ELEVENLABS_ONLY ?? ''}`.trim();
        return v === '1' || v.toLowerCase() === 'true';
    }
    isStrictElevenLabsOnly() {
        const v = `${this.config.get('STRICT_ELEVENLABS_ONLY') ?? process.env.STRICT_ELEVENLABS_ONLY ?? 'true'}`.trim();
        return !(v === '0' || v.toLowerCase() === 'false');
    }
    resolveGatherHearingDebugEffective() {
        return this.isGatherHearingDebugMode() && !this.isForceElevenLabsOnly() && !this.isStrictElevenLabsOnly();
    }
    async resolveShortPhrasePlayUrl(params) {
        const voiceId = this.resolveElevenLabsVoiceId(params.agent);
        const voiceProviderRequested = 'elevenlabs';
        const forceElOnly = this.isForceElevenLabsOnly();
        if (params.hearingDebugEffective) {
            this.logger.warn(JSON.stringify({
                event: 'twilio.voice.phrase_audio',
                callSessionId: params.callSessionId,
                tenantId: params.tenantId,
                phrase: params.logLabel,
                voiceProviderRequested,
                voiceIdUsed: voiceId ?? null,
                voiceProviderActuallyUsed: 'twilio_say_fallback',
                twimlVerbUsed: 'Say',
                voiceFallbackToTwilioSay: true,
                fallbackReason: 'twilio_gather_hearing_debug',
                emergencyTwilioSayFallback: forceElOnly,
            }));
            return { voiceProviderActuallyUsed: 'twilio_say_fallback' };
        }
        if (!voiceId || !/^https:\/\//i.test(params.origin)) {
            this.logger.warn(JSON.stringify({
                event: 'twilio.voice.phrase_audio',
                callSessionId: params.callSessionId,
                phrase: params.logLabel,
                voiceProviderRequested,
                voiceIdUsed: voiceId ?? null,
                voiceProviderActuallyUsed: 'twilio_say_fallback',
                twimlVerbUsed: 'Say',
                voiceFallbackToTwilioSay: true,
                fallbackReason: !voiceId ? 'no_elevenlabs_voice_id' : 'webhook_base_not_https',
                emergencyTwilioSayFallback: forceElOnly,
            }));
            return { voiceProviderActuallyUsed: 'twilio_say_fallback' };
        }
        const r = await this.voicePromptAudio.createPhrasePlaybackUrl(params.origin, {
            text: params.text,
            voiceId,
            apiKey: params.agent.elevenlabsApiKey ?? undefined,
            modelId: params.agent.elevenlabsModel ?? undefined,
            styleNotes: params.agent.voiceStyle ?? undefined,
        });
        if (!r.playbackUrl) {
            this.logger.warn(JSON.stringify({
                event: 'twilio.voice.phrase_audio',
                callSessionId: params.callSessionId,
                phrase: params.logLabel,
                voiceProviderRequested,
                voiceIdUsed: voiceId,
                voiceProviderActuallyUsed: 'twilio_say_fallback',
                twimlVerbUsed: 'Say',
                voiceFallbackToTwilioSay: true,
                fallbackReason: 'elevenlabs_phrase_failed',
                emergencyTwilioSayFallback: forceElOnly,
            }));
            return { voiceProviderActuallyUsed: 'twilio_say_fallback' };
        }
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.phrase_audio',
            callSessionId: params.callSessionId,
            phrase: params.logLabel,
            voiceProviderRequested,
            voiceIdUsed: voiceId,
            voiceProviderActuallyUsed: 'elevenlabs',
            twimlVerbUsed: 'Play',
            fromPhraseCache: r.fromPhraseCache,
        }));
        return { playbackUrl: r.playbackUrl, voiceProviderActuallyUsed: 'elevenlabs' };
    }
    async loadAgentWorkspaceFlags(agentId) {
        if (!agentId) {
            return { useWorkspaceOpenai: false, useWorkspaceElevenlabs: false };
        }
        const cfg = await this.prisma.agentConfig.findUnique({
            where: { agentId },
            select: { useWorkspaceOpenai: true, useWorkspaceElevenlabs: true },
        });
        return {
            useWorkspaceOpenai: cfg?.useWorkspaceOpenai === true,
            useWorkspaceElevenlabs: cfg?.useWorkspaceElevenlabs === true,
        };
    }
    decryptAgentSecrets(secretsEnc) {
        if (!secretsEnc || !this.encryption.isAvailable())
            return {};
        const dec = this.encryption.decryptFromStorage(secretsEnc);
        if (!dec)
            return {};
        try {
            return JSON.parse(dec);
        }
        catch {
            return {};
        }
    }
    async getWorkspaceIntegrationSlice(tenantId) {
        const row = await this.prisma.tenantIntegration.findUnique({
            where: { tenantId },
            select: {
                shopifyShopDomain: true,
                shopifyAdminTokenEnc: true,
                openaiApiKeyEnc: true,
                elevenlabsApiKeyEnc: true,
                elevenlabsDefaultVoiceId: true,
                twilioAccountSid: true,
                twilioAuthTokenEnc: true,
                twilioPhoneNumber: true,
                resendApiKeyEnc: true,
            },
        });
        if (!row || !this.encryption.isAvailable())
            return null;
        return {
            shopifyStoreUrl: row.shopifyShopDomain?.trim()
                ? `https://${row.shopifyShopDomain.trim()}`
                : undefined,
            shopifyAdminToken: row.shopifyAdminTokenEnc
                ? (this.encryption.decryptFromStorage(row.shopifyAdminTokenEnc) ?? undefined)
                : undefined,
            openaiApiKey: row.openaiApiKeyEnc
                ? (this.encryption.decryptFromStorage(row.openaiApiKeyEnc) ?? undefined)
                : undefined,
            elevenlabsApiKey: row.elevenlabsApiKeyEnc
                ? (this.encryption.decryptFromStorage(row.elevenlabsApiKeyEnc) ?? undefined)
                : undefined,
            elevenlabsDefaultVoiceId: row.elevenlabsDefaultVoiceId?.trim() || undefined,
            twilioAccountSid: row.twilioAccountSid?.trim() || undefined,
            twilioAuthToken: row.twilioAuthTokenEnc
                ? (this.encryption.decryptFromStorage(row.twilioAuthTokenEnc) ?? undefined)
                : undefined,
            twilioPhoneNumber: row.twilioPhoneNumber?.trim() || undefined,
            resendApiKey: row.resendApiKeyEnc
                ? (this.encryption.decryptFromStorage(row.resendApiKeyEnc) ?? undefined)
                : undefined,
        };
    }
    async auditOpenAiKeyForGather(tenantId, secretsEnc, agentId) {
        let agentOpenaiPlain = null;
        if (secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(secretsEnc);
            if (dec) {
                try {
                    const secrets = JSON.parse(dec);
                    agentOpenaiPlain = typeof secrets.openaiApiKey === 'string' ? secrets.openaiApiKey : null;
                }
                catch {
                }
            }
        }
        const ti = this.encryption.isAvailable()
            ? await this.prisma.tenantIntegration.findUnique({
                where: { tenantId },
                select: { openaiApiKeyEnc: true },
            })
            : null;
        const encAvail = this.encryption.isAvailable();
        const workspaceFlags = await this.loadAgentWorkspaceFlags(agentId);
        const envPlain = (0, provider_env_slice_util_1.gatedProcessEnv)('OPENAI_API_KEY', this.config);
        const openaiR = (0, voice_config_resolution_util_1.resolveOpenAiKeyChain)({
            agentSecretPlain: agentOpenaiPlain,
            tenantEnc: ti?.openaiApiKeyEnc ?? null,
            decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
            envPlain,
            encryptionAvailable: encAvail,
            useWorkspaceOpenai: workspaceFlags.useWorkspaceOpenai,
        });
        const layers = (0, voice_config_resolution_util_1.openAiKeyLayerPresence)({
            agentSecretPlain: agentOpenaiPlain,
            tenantEnc: ti?.openaiApiKeyEnc ?? null,
            envPlain,
            useWorkspaceOpenai: workspaceFlags.useWorkspaceOpenai,
        });
        return {
            openaiKeySource: openaiR.source,
            openaiKeyFingerprint: (0, api_key_fingerprint_1.fingerprintApiKey)(openaiR.value),
            agentKeyPresent: layers.agentKeyPresent,
            tenantKeyPresent: layers.tenantKeyPresent,
            envKeyPresent: layers.envKeyPresent,
            agentOverridesWorkspaceOpenai: layers.agentKeyPresent && layers.tenantKeyPresent,
        };
    }
    getSessionLanguage(ctx) {
        const metadataLanguage = typeof ctx?.metadata?.language === 'string' ? ctx.metadata.language.trim().toLowerCase() : '';
        if (metadataLanguage)
            return (0, language_intelligence_util_1.normalizeLanguageForTwilio)(metadataLanguage);
        return (0, language_intelligence_util_1.normalizeLanguageForTwilio)(ctx?.agent.language ?? 'en');
    }
    async handleInboundVoice(payload) {
        const normalizedTo = (0, normalize_phone_1.normalizePhoneNumber)(payload.To);
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.inbound_received',
            callSid: payload.CallSid,
            from: maskPhoneForLog(payload.From),
            to: maskPhoneForLog(payload.To),
            toNormalizedLast4: normalizedTo.replace(/\D/g, '').slice(-4),
        }));
        const context = await this.agentResolution.resolveByPhoneNumber(payload.To);
        if (!context) {
            this.logger.warn(JSON.stringify({
                event: 'twilio.voice.agent_not_resolved',
                callSid: payload.CallSid,
                to: maskPhoneForLog(payload.To),
                toNormalizedLast4: normalizedTo.replace(/\D/g, '').slice(-4),
                mappingFound: false,
            }));
            const twiml = (0, conversation_relay_twiml_1.buildFallbackTwiML)();
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.twiml_returned',
                route: 'inbound',
                agentResolved: false,
                twimlChars: twiml.length,
                playback: 'fallback_twiml',
                ttsFallbackUsed: true,
                playbackChannel: 'twilio_say',
            }));
            return { twiml, agentResolved: false };
        }
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.agent_resolved',
            callSid: payload.CallSid,
            agentId: context.agentId,
            tenantId: context.tenantId,
            storeId: context.storeId,
            phoneNumberId: context.phoneNumberId,
            to: maskPhoneForLog(payload.To),
            toNormalizedLast4: normalizedTo.replace(/\D/g, '').slice(-4),
            mappingFound: true,
        }));
        const session = await this.callsService.createSession({
            tenantId: context.tenantId,
            storeId: context.storeId,
            agentId: context.agentId,
            phoneNumberId: context.phoneNumberId,
            twilioCallSid: payload.CallSid,
            fromNumber: payload.From,
            toNumber: payload.To,
            direction: 'inbound',
        });
        await this.callEvents.log(context.tenantId, session.id, client_1.CallEventType.INBOUND_CALL_RECEIVED, {
            from: payload.From,
            to: payload.To,
            twilioCallSid: payload.CallSid,
        });
        await this.callEvents.log(context.tenantId, session.id, client_1.CallEventType.CALL_SESSION_CREATED, {
            agentId: context.agentId,
            storeId: context.storeId,
        });
        await this.callEvents.log(context.tenantId, session.id, client_1.CallEventType.AGENT_RESOLVED, {
            agentId: context.agentId,
            to: payload.To,
        });
        console.log('[voice-runtime] loaded agent', context.agentId, context.agent.name);
        const agentRow = await this.prisma.agent.findFirst({
            where: { id: context.agentId, tenantId: context.tenantId, deletedAt: null },
            select: { updatedAt: true },
        });
        console.log('[voice-runtime] using prompt version', agentRow?.updatedAt?.toISOString() ?? 'unknown');
        this.logger.log(JSON.stringify({
            event: 'voice.journey.call_session_created',
            callSessionId: session.id,
            tenantId: context.tenantId,
            agentId: context.agentId,
            agentName: context.agent.name,
            storeId: context.storeId,
            twilioCallSid: payload.CallSid,
            configUpdatedAt: agentRow?.updatedAt?.toISOString() ?? null,
        }));
        const runtimeAgentRow = await this.prisma.agent.findFirst({
            where: { id: context.agentId, tenantId: context.tenantId, deletedAt: null },
            select: {
                status: true,
                shopifyStoreUrl: true,
                voiceId: true,
                secretsEnc: true,
                agentConfig: {
                    select: {
                        useWorkspaceShopify: true,
                        useWorkspaceOpenai: true,
                        useWorkspaceElevenlabs: true,
                        useWorkspaceTwilio: true,
                        useWorkspaceEmail: true,
                    },
                },
            },
        });
        if (runtimeAgentRow) {
            const [workspaceSlice, sessionCtx] = await Promise.all([
                this.getWorkspaceIntegrationSlice(context.tenantId),
                this.sessionContext.load(session.id),
            ]);
            const sources = (0, credential_resolver_util_1.buildCredentialSourcesSummary)({
                agent: {
                    shopifyStoreUrl: runtimeAgentRow.shopifyStoreUrl,
                    voiceId: runtimeAgentRow.voiceId,
                    secrets: this.decryptAgentSecrets(runtimeAgentRow.secretsEnc),
                    useWorkspaceShopify: runtimeAgentRow.agentConfig?.useWorkspaceShopify === true,
                    useWorkspaceOpenai: runtimeAgentRow.agentConfig?.useWorkspaceOpenai === true,
                    useWorkspaceElevenlabs: runtimeAgentRow.agentConfig?.useWorkspaceElevenlabs === true,
                    useWorkspaceTwilio: runtimeAgentRow.agentConfig?.useWorkspaceTwilio === true,
                    useWorkspaceEmail: runtimeAgentRow.agentConfig?.useWorkspaceEmail === true,
                },
                workspace: workspaceSlice,
            });
            const missingRequirements = [
                !sources.openai.configured ? 'openai' : null,
                !sources.twilio.configured ? 'twilio' : null,
                !sources.elevenlabs.configured && (sessionCtx?.agent.voiceProvider ?? '').toLowerCase() === 'elevenlabs'
                    ? 'elevenlabs'
                    : null,
                !sources.resend.configured ? 'resend' : null,
            ].filter((v) => Boolean(v));
            this.logger.log(JSON.stringify({
                event: 'voice.runtime.readiness.summary',
                callSessionId: session.id,
                agentId: context.agentId,
                tenantId: context.tenantId,
                agentStatus: runtimeAgentRow.status,
                openaiSource: sources.openai.source,
                twilioSource: sources.twilio.authSource,
                elevenlabsSource: sources.elevenlabs.source,
                resendSource: sources.resend.source,
                missingRequirements,
            }));
        }
        const origin = this.getPublicBaseUrl();
        if ((0, media_stream_twiml_1.isMediaStreamInboundEnabled)()) {
            const wsBase = origin.replace(/^http/i, 'wss');
            const streamUrl = `${wsBase}/api/twilio/voice/media-stream?callSessionId=${encodeURIComponent(session.id)}`;
            const twimlStream = (0, media_stream_twiml_1.buildMediaStreamConnectTwiML)(streamUrl, session.id);
            await this.streamMetrics.merge(session.id, {
                streamingMode: 'media_stream',
                streamingStatus: 'listening',
            });
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.inbound_media_stream',
                callSessionId: session.id,
            }));
            return { twiml: twimlStream, callSessionId: session.id, agentResolved: true };
        }
        const gatherActionUrl = `${origin}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(session.id)}`;
        const hearingDebug = this.isGatherHearingDebugMode();
        const hearingDebugEffective = this.resolveGatherHearingDebugEffective();
        const forceElOnly = this.isForceElevenLabsOnly();
        const strictElevenLabsOnly = this.isStrictElevenLabsOnly();
        const debugOpeningText = 'Please say your question after the beep.';
        const elOptsInbound = await this.loadElevenLabsTtsOptions(context);
        const greetingText = context.agent.greetingMessage ??
            `Hello, you've reached ${context.store.name}. How can I help you today?`;
        const maxGreetingMs = this.getVoiceGreetingMaxMs();
        const shortGreeting = this.shortenGreetingForCapture(greetingText, maxGreetingMs);
        const estimatedGreetingMs = this.estimateGreetingAudioMs(shortGreeting);
        const fallbackText = context.agent.fallbackMessage?.trim() ??
            "We're having trouble hearing you. Please call again later. Goodbye.";
        let greetingPlaybackUrl;
        let greetingVoice = 'twilio_say_fallback';
        let finalFallbackAudioUrl;
        let finalFallbackVoice = 'twilio_say_fallback';
        const shouldTryElGreeting = (!hearingDebug || forceElOnly) && elOptsInbound.voiceId && /^https:\/\//i.test(origin);
        if (shouldTryElGreeting && estimatedGreetingMs <= maxGreetingMs) {
            const inboundVoiceId = elOptsInbound.voiceId;
            const openingForTts = hearingDebug && forceElOnly ? debugOpeningText : shortGreeting;
            const gPlay = await this.voicePromptAudio.createPhrasePlaybackUrl(origin, {
                text: openingForTts,
                voiceId: inboundVoiceId,
                apiKey: elOptsInbound.apiKey,
                modelId: elOptsInbound.model,
            });
            if (gPlay.playbackUrl) {
                greetingPlaybackUrl = gPlay.playbackUrl;
                greetingVoice = 'elevenlabs';
            }
            const fPlay = await this.voicePromptAudio.createPhrasePlaybackUrl(origin, {
                text: fallbackText,
                voiceId: inboundVoiceId,
                apiKey: elOptsInbound.apiKey,
                modelId: elOptsInbound.model,
            });
            if (fPlay.playbackUrl) {
                finalFallbackAudioUrl = fPlay.playbackUrl;
                finalFallbackVoice = 'elevenlabs';
            }
        }
        const greetingReplyVerb = greetingPlaybackUrl && !hearingDebugEffective ? 'Play' : 'Say';
        const providerUsed = greetingVoice === 'elevenlabs' ? 'elevenlabs' : 'twilio_say';
        const voiceIdUsedInbound = elOptsInbound.voiceId ?? null;
        console.log(JSON.stringify({
            event: 'twilio.voice.inbound_voice_summary',
            loadedAgentId: context.agentId,
            dialedTo: maskPhoneForLog(payload.To),
            voiceProvider: context.agent.voiceProvider ?? null,
            voiceProviderRequested: 'elevenlabs',
            voiceIdUsed: voiceIdUsedInbound,
            voiceIdPresent: Boolean(context.agent.voiceId?.trim() || elOptsInbound.voiceId),
            voiceIdForElevenLabsTts: elOptsInbound.voiceId ? 'present' : 'missing',
            elevenLabsKeySource: elOptsInbound.keySource,
            providerUsed,
            voiceProviderActuallyUsed: greetingReplyVerb === 'Play' ? 'elevenlabs' : 'twilio_say_fallback',
            twimlVerbUsed: greetingReplyVerb,
            voiceProviderActuallyUsedOpening: hearingDebugEffective ? 'twilio_say_fallback' : greetingVoice,
            voiceProviderActuallyUsedFinalFallback: hearingDebugEffective ? 'twilio_say_fallback' : finalFallbackVoice,
            callSessionId: session.id,
            gatherActionUrlIncludesCallSessionId: gatherActionUrl.includes('callSessionId='),
            gatherActionUrlFull: gatherActionUrl,
            gatherActionUrlHost: (() => {
                try {
                    return new URL(gatherActionUrl).host;
                }
                catch {
                    return 'invalid_url';
                }
            })(),
            greetingReplyVerb,
            greetingUsedElevenLabsAudio: Boolean(greetingPlaybackUrl),
            gatherHearingDebugSayOnly: hearingDebugEffective,
            FORCE_ELEVENLABS_ONLY: forceElOnly,
        }));
        this.logger.log(JSON.stringify({
            event: 'voice.runtime.url_summary',
            route: 'inbound',
            publicBaseUrl: origin,
            gatherActionUrl,
            playAudioUrl: hearingDebugEffective ? null : (greetingPlaybackUrl ?? null),
        }));
        this.logger.log(JSON.stringify({
            event: 'voice.gather.capture_timing',
            callSessionId: session.id,
            greetingAudioMs: estimatedGreetingMs,
            timeUntilGatherListening: 0,
            speechDetected: false,
            speechResultChars: 0,
            emptySpeechRate: 0,
        }));
        const twiml = (0, gather_mvp_twiml_1.buildInboundGatherMvpTwiML)({
            gatherActionUrl,
            language: hearingDebug ? 'en-US' : (0, language_intelligence_util_1.normalizeLanguageForTwilio)(context.agent.language ?? 'en'),
            playbackAudioUrl: hearingDebugEffective ? undefined : greetingPlaybackUrl,
            openingSayText: hearingDebugEffective || !greetingPlaybackUrl
                ? shortGreeting
                : undefined,
            finalFallbackAudioUrl: hearingDebugEffective ? undefined : finalFallbackAudioUrl,
            finalFallbackSayText: strictElevenLabsOnly || hearingDebugEffective || finalFallbackAudioUrl ? undefined : fallbackText,
            timeoutSeconds: 5,
            speechTimeout: 'auto',
            pauseBeforeListenSeconds: 0,
            includePromptInsideGather: false,
        });
        const greetingSeq = await this.transcriptBuffer.getNextSequence(session.id);
        await this.transcriptBuffer.append(session.id, 'system', `Inbound call received from ${payload.From} to ${payload.To}.`, greetingSeq);
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.twiml_returned',
            route: 'inbound',
            callSessionId: session.id,
            agentResolved: true,
            twimlChars: twiml.length,
            playback: greetingPlaybackUrl ? 'elevenlabs_audio' : 'twilio_say',
            ttsFallbackUsed: !greetingPlaybackUrl,
            playbackChannel: greetingPlaybackUrl ? 'elevenlabs' : 'twilio_say',
            voiceProviderActuallyUsedOpening: hearingDebugEffective ? 'twilio_say_fallback' : greetingVoice,
            voiceProviderActuallyUsedFinalFallback: hearingDebugEffective ? 'twilio_say_fallback' : finalFallbackVoice,
            voiceProviderActuallyUsed: greetingReplyVerb === 'Play' ? 'elevenlabs' : 'twilio_say_fallback',
            twimlVerbUsed: greetingReplyVerb,
        }));
        return {
            twiml,
            callSessionId: session.id,
            agentResolved: true,
        };
    }
    async handleGatherMvpVoice(payload) {
        const handlerStartedAt = Date.now();
        console.log('Gather body (keys):', Object.keys(payload).join(','));
        console.log('Gather speech:', JSON.stringify({
            SpeechResult: (payload.SpeechResult ?? '').slice(0, 200),
            StableSpeechResult: (payload.StableSpeechResult ?? '').slice(0, 200),
            Confidence: payload.Confidence ?? '',
            CallSid: payload.CallSid ?? '',
        }));
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.gather_received',
            callSid: payload.CallSid,
            callSessionId: payload.callSessionId?.trim() || undefined,
            from: maskPhoneForLog(payload.From),
            to: maskPhoneForLog(payload.To),
            hasSpeechResult: Boolean(((payload.SpeechResult ?? '').trim() || (payload.StableSpeechResult ?? '').trim()).length),
            confidence: payload.Confidence ?? undefined,
        }));
        let callSessionId = payload.callSessionId?.trim() ?? '';
        if (!callSessionId && payload.CallSid) {
            const session = await this.callsService.findOneByTwilioCallSid(payload.CallSid);
            callSessionId = session?.id ?? '';
        }
        if (!callSessionId) {
            const twiml = (0, conversation_relay_twiml_1.buildFallbackTwiML)("I'm sorry, I couldn't resume your call. Please try again.");
            this.logger.warn(JSON.stringify({ event: 'twilio.voice.gather_missing_session', callSid: payload.CallSid }));
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.twiml_returned',
                route: 'gather',
                agentResolved: false,
                twimlChars: twiml.length,
                playback: 'fallback_twiml',
                ttsFallbackUsed: true,
                playbackChannel: 'twilio_say',
            }));
            return {
                twiml,
                agentResolved: false,
            };
        }
        const unstablePartial = typeof payload.UnstableSpeechResult === 'string'
            ? payload.UnstableSpeechResult.trim()
            : '';
        if (unstablePartial) {
            await this.streamMetrics.recordPartialTranscript(callSessionId, unstablePartial);
        }
        await this.streamingSession.cancelDeferredJobForBargeIn(callSessionId);
        await this.streamMetrics.merge(callSessionId, {
            sttLatencyMs: Date.now() - handlerStartedAt,
            streamingMode: 'gather_deferred',
        });
        const ctx = await this.sessionContext.load(callSessionId);
        if (!ctx) {
            const twiml = (0, conversation_relay_twiml_1.buildFallbackTwiML)("I'm sorry, I couldn't load your call session. Please try again.");
            this.logger.warn(JSON.stringify({ event: 'twilio.voice.gather_context_missing', callSessionId }));
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.twiml_returned',
                route: 'gather',
                agentResolved: false,
                twimlChars: twiml.length,
                playback: 'fallback_twiml',
                ttsFallbackUsed: true,
                playbackChannel: 'twilio_say',
            }));
            return {
                twiml,
                agentResolved: false,
            };
        }
        const gatherSecretsRow = await this.prisma.agent.findUnique({
            where: { id: ctx.agentId },
            select: { secretsEnc: true },
        });
        const openAiKeyAudit = await this.auditOpenAiKeyForGather(ctx.tenantId, gatherSecretsRow?.secretsEnc, ctx.agentId);
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.gather_openai_key_proof',
            callSessionId,
            callSid: payload.CallSid,
            ...openAiKeyAudit,
        }));
        const { keySource: gatherElevenLabsKeySource } = await this.resolveElevenLabsApiKeyAndSource(ctx.tenantId, gatherSecretsRow?.secretsEnc, ctx.agentId);
        const session = await this.callsService.findOneById(callSessionId);
        if (session.status !== client_1.CallStatus.IN_PROGRESS) {
            await this.voiceRuntime.onRuntimeConnected(callSessionId);
        }
        const hearingDebug = this.isGatherHearingDebugMode();
        const hearingDebugEffective = this.resolveGatherHearingDebugEffective();
        const strictElevenLabsOnly = this.isStrictElevenLabsOnly();
        const speechText = ((payload.SpeechResult ?? '').trim() ||
            (payload.StableSpeechResult ?? '').trim()).trim();
        if (!speechText) {
            console.log(JSON.stringify({
                event: 'twilio.gather.empty_speech_diagnosis',
                callSid: payload.CallSid,
                callSessionId: payload.callSessionId?.trim() || null,
                checks: {
                    spokeDuringPromptAudio: 'Twilio only starts recognition after inner Play/Say/Pause finish; speech during greeting is dropped.',
                    timeoutTooShort: 'Gather uses timeout=5s (start speaking) and speechTimeout=auto for conversational flow.',
                    languageMismatch: 'Gather language is derived from agent/session; wrong code hurts recognition.',
                    enhancedOrSpeechModel: 'enhanced and speechModel removed from TwiML for compatibility.',
                    twilioPostedToGather: 'This log line confirms Twilio reached your /api/twilio/voice/gather handler for this turn.',
                },
            }));
        }
        const confidenceStr = (payload.Confidence ?? '').trim();
        const confidenceParsed = confidenceStr === '' ? NaN : Number(confidenceStr);
        const confidence = Number.isFinite(confidenceParsed) ? confidenceParsed : null;
        const lowConfidence = confidence !== null && confidence < 0.25;
        const hasUsableSpeech = speechText.length >= 2 && !lowConfidence;
        let assistantResponse;
        const metadata = ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
            ? ctx.metadata
            : {};
        const gatherRetryCount = Number(metadata.gatherRetryCount ?? 0);
        this.logger.log(JSON.stringify({
            event: 'voice.gather.capture_timing',
            callSessionId,
            greetingAudioMs: 0,
            timeUntilGatherListening: 0,
            speechDetected: speechText.length > 0,
            speechResultChars: speechText.length,
            emptySpeechRate: speechText.length > 0 ? 0 : Math.min(1, (gatherRetryCount + 1) / (gatherRetryCount + 2)),
        }));
        console.log(JSON.stringify({
            event: 'twilio.voice.gather_speech_gate',
            callSessionId,
            callSessionIdFromQuery: payload.callSessionId?.trim() || null,
            speechResultRaw: (payload.SpeechResult ?? '').slice(0, 300),
            stableSpeechRaw: (payload.StableSpeechResult ?? '').slice(0, 300),
            speechTextMerged: speechText.slice(0, 300),
            confidenceRawField: confidenceStr || null,
            confidenceParsed: confidence,
            lowConfidence,
            hasUsableSpeech,
            willCallVoiceRuntime: false,
            voiceDeferredKickoff: hasUsableSpeech,
            openaiKeySource: openAiKeyAudit.openaiKeySource,
            openaiKeyFingerprint: openAiKeyAudit.openaiKeyFingerprint,
            agentKeyPresent: openAiKeyAudit.agentKeyPresent,
            tenantKeyPresent: openAiKeyAudit.tenantKeyPresent,
            envKeyPresent: openAiKeyAudit.envKeyPresent,
            agentOverridesWorkspaceOpenai: openAiKeyAudit.agentOverridesWorkspaceOpenai,
        }));
        if (!speechText.trim()) {
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.gather_twilio_speech_empty',
                callSessionId,
                callSid: payload.CallSid,
                diagnosis: 'OpenAI key is not the cause. Twilio did not capture speech.',
            }));
        }
        if (!hasUsableSpeech) {
            const nextRetry = gatherRetryCount + 1;
            await this.callsService.mergeSessionMetadata(callSessionId, { gatherRetryCount: nextRetry });
            const seq = await this.transcriptBuffer.getNextSequence(callSessionId);
            await this.transcriptBuffer.append(callSessionId, 'system', !speechText
                ? 'No speech captured from Twilio Gather.'
                : `Low-confidence speech from Twilio Gather (confidence=${confidence ?? 'unknown'}).`, seq);
            if (nextRetry >= 2) {
                const finalMsg = ctx.agent.fallbackMessage?.trim() ??
                    'I am having trouble hearing you. Please call again or wait for a human assistant.';
                const seqA = await this.transcriptBuffer.getNextSequence(callSessionId);
                await this.transcriptBuffer.append(callSessionId, 'agent', finalMsg, seqA);
                const origin = this.getPublicBaseUrl();
                const { playbackUrl: finalPlay } = await this.buildElevenLabsPlaybackUrl(origin, finalMsg, {
                    callSessionId,
                    tenantId: ctx.tenantId,
                    phase: 'gather_reply',
                    voiceId: this.resolveElevenLabsVoiceId(ctx.agent),
                    elevenlabsApiKey: ctx.agent.elevenlabsApiKey ?? undefined,
                    elevenlabsModel: ctx.agent.elevenlabsModel ?? undefined,
                    voiceStyle: ctx.agent.voiceStyle ?? undefined,
                });
                const twiml = (0, gather_mvp_twiml_1.buildVoiceTerminalTwiml)({
                    playbackAudioUrl: finalPlay,
                    sayText: finalPlay ? undefined : finalMsg,
                    language: this.getSessionLanguage(ctx),
                });
                console.log(JSON.stringify({
                    event: 'twilio.voice.gather_terminal_empty_speech',
                    callSessionId,
                    emptyAttempts: nextRetry,
                    loadedAgentId: ctx.agentId,
                    dialedTo: maskPhoneForLog(payload.To),
                    voiceProvider: ctx.agent.voiceProvider ?? null,
                    voiceIdPresent: Boolean(ctx.agent.voiceId?.trim()),
                    elevenLabsKeySource: gatherElevenLabsKeySource,
                    replyVerb: finalPlay ? 'Play' : 'Say',
                    voiceProviderActuallyUsed: finalPlay ? 'elevenlabs' : 'twilio_say_fallback',
                    SpeechResult: speechText.slice(0, 200),
                    StableSpeechResult: (payload.StableSpeechResult ?? '').slice(0, 200),
                    Confidence: payload.Confidence ?? '',
                }));
                this.logger.log(JSON.stringify({
                    event: 'twilio.voice.twiml_returned',
                    route: 'gather',
                    callSessionId,
                    agentResolved: true,
                    twimlChars: twiml.length,
                    playback: finalPlay ? 'elevenlabs_audio' : 'twilio_say',
                    terminal: true,
                    voiceProviderActuallyUsed: finalPlay ? 'elevenlabs' : 'twilio_say_fallback',
                    'twilio.response_latency_ms': Date.now() - handlerStartedAt,
                }));
                return { twiml, callSessionId, agentResolved: true };
            }
            assistantResponse = 'Go ahead.';
            const seq2 = await this.transcriptBuffer.getNextSequence(callSessionId);
            await this.transcriptBuffer.append(callSessionId, 'agent', assistantResponse, seq2);
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.llm_reply_skipped',
                callSessionId,
                reason: !speechText ? 'empty_gather_speech' : 'low_confidence_gather_speech',
                confidence,
                replyChars: assistantResponse.length,
                retryAttempt: nextRetry,
            }));
        }
        else {
            await this.callsService.mergeSessionMetadata(callSessionId, { gatherRetryCount: 0 });
            this.logger.log(JSON.stringify({
                event: 'voice.journey.twilio_speech_received',
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                speechCharCount: speechText.length,
                voicePipeline: 'deferred_async',
            }));
            const originEarly = this.getPublicBaseUrl();
            const orderStateForAck = typeof metadata.orderState === 'string' && metadata.orderState.trim()
                ? metadata.orderState.trim()
                : 'IDLE';
            const userIntent = (0, user_intent_classifier_util_1.classifyUserIntent)(speechText);
            const ackSelection = (0, instant_acknowledgement_util_1.selectInstantAcknowledgement)({
                intent: userIntent,
                speechText,
                callState: orderStateForAck,
                metadata,
            });
            const letMeCheckUsedBefore = metadata.letMeCheckUsed === true;
            if (ackSelection.mode === 'sync_full_reply') {
                const utter = await this.voiceRuntime.processUtterance(callSessionId, speechText, []);
                const syncPatch = (0, instant_acknowledgement_util_1.buildInstantAckMetadataPatch)({
                    selection: ackSelection,
                    intent: userIntent,
                    letMeCheckUsedBefore,
                    instantPhraseForLog: null,
                    syncReplyText: utter.reply,
                });
                await this.callsService.mergeSessionMetadata(callSessionId, syncPatch);
                this.logger.log(JSON.stringify({
                    event: 'twilio.voice.instant_ack_selected',
                    callSessionId,
                    tenantId: ctx.tenantId,
                    agentId: ctx.agentId,
                    instantAckSelected: utter.reply.slice(0, 160),
                    ackReason: ackSelection.ackReason,
                    letMeCheckUsedBefore,
                    letMeCheckUsedAfter: syncPatch.letMeCheckUsed,
                    intentDetected: userIntent,
                    pipeline: 'sync_full_reply_no_deferred',
                }));
                const gatherActionUrlSync = `${originEarly}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(callSessionId)}`;
                const gatherFallbackTextSync = ctx.agent.fallbackMessage?.trim() ?? "We're having trouble hearing you. Please call again later. Goodbye.";
                const hearingDebugEffectiveSync = this.resolveGatherHearingDebugEffective();
                const syncTtsBudgetMs = Math.max(400, 2000 - (Date.now() - handlerStartedAt));
                const mainPlay = await this.withTimeout(this.buildElevenLabsPlaybackUrl(originEarly, utter.reply, {
                    callSessionId,
                    tenantId: ctx.tenantId,
                    phase: 'gather_reply',
                    voiceId: this.resolveElevenLabsVoiceId(ctx.agent),
                    elevenlabsApiKey: ctx.agent.elevenlabsApiKey ?? undefined,
                    elevenlabsModel: ctx.agent.elevenlabsModel ?? undefined,
                    voiceStyle: ctx.agent.voiceStyle ?? undefined,
                }), syncTtsBudgetMs, {});
                const finalFbSync = await this.resolveShortPhrasePlayUrl({
                    origin: originEarly,
                    hearingDebugEffective: hearingDebugEffectiveSync,
                    text: gatherFallbackTextSync,
                    tenantId: ctx.tenantId,
                    callSessionId,
                    agent: ctx.agent,
                    logLabel: 'gather_sync_social_final_fallback',
                });
                this.logger.log(JSON.stringify({
                    event: 'voice.runtime.url_summary',
                    route: 'gather_sync_social_reply',
                    publicBaseUrl: originEarly,
                    gatherActionUrl: gatherActionUrlSync,
                    playAudioUrl: mainPlay.playbackUrl ?? null,
                }));
                const twimlSync = (0, gather_mvp_twiml_1.buildInboundGatherMvpTwiML)({
                    gatherActionUrl: gatherActionUrlSync,
                    language: this.getSessionLanguage(ctx),
                    playbackAudioUrl: mainPlay.playbackUrl,
                    finalFallbackAudioUrl: finalFbSync.playbackUrl,
                    openingSayText: strictElevenLabsOnly || mainPlay.playbackUrl ? undefined : utter.reply,
                    finalFallbackSayText: strictElevenLabsOnly || finalFbSync.playbackUrl ? undefined : gatherFallbackTextSync,
                    timeoutSeconds: 10,
                    speechTimeout: '2',
                    pauseBeforeListenSeconds: 0,
                });
                this.logTwilioResponseMetrics('gather_sync_social_reply', callSessionId, handlerStartedAt);
                this.logger.log(JSON.stringify({
                    event: 'twilio.voice.twiml_returned',
                    route: 'gather_sync_social_reply',
                    callSessionId,
                    agentResolved: true,
                    twimlChars: twimlSync.length,
                    playback: mainPlay.playbackUrl ? 'elevenlabs_audio' : 'twilio_say',
                    intentDetected: userIntent,
                    voiceProviderActuallyUsedMain: mainPlay.playbackUrl ? 'elevenlabs' : 'twilio_say_fallback',
                    responseDelayMs: Date.now() - handlerStartedAt,
                    slowHandlerWarning: Date.now() - handlerStartedAt > 2000,
                    'twilio.response_latency_ms': Date.now() - handlerStartedAt,
                }));
                return {
                    twiml: twimlSync,
                    callSessionId,
                    agentResolved: true,
                };
            }
            const instantPhrase = ackSelection.mode === 'deferred_kickoff' ? ackSelection.instantPhrase : null;
            const kickText = instantPhrase?.trim() ?? '';
            const deferredPatch = (0, instant_acknowledgement_util_1.buildInstantAckMetadataPatch)({
                selection: ackSelection,
                intent: userIntent,
                letMeCheckUsedBefore,
                instantPhraseForLog: instantPhrase,
            });
            const letMeCheckUsedAfter = deferredPatch.letMeCheckUsed;
            const jobId = (0, crypto_1.randomUUID)();
            await this.callsService.mergeSessionMetadata(callSessionId, {
                ...deferredPatch,
                deferredVoiceJob: {
                    jobId,
                    phase: 'processing',
                    startedAtMs: Date.now(),
                    momentPromptPlayed: false,
                },
            });
            this.kickDeferredVoiceProcessing(callSessionId, speechText, jobId);
            const deferPollUrl = `${originEarly}/api/twilio/voice/deferred-poll?callSessionId=${encodeURIComponent(callSessionId)}`;
            let kickPhrase = {
                voiceProviderActuallyUsed: 'twilio_say_fallback',
            };
            if (kickText.length > 0) {
                const kickBudgetMs = Math.max(300, 2000 - (Date.now() - handlerStartedAt));
                kickPhrase = await this.withTimeout(this.resolveShortPhrasePlayUrl({
                    origin: originEarly,
                    hearingDebugEffective,
                    text: kickText,
                    tenantId: ctx.tenantId,
                    callSessionId,
                    agent: ctx.agent,
                    logLabel: 'deferred_kickoff',
                }), kickBudgetMs, { voiceProviderActuallyUsed: 'twilio_say_fallback' });
            }
            const allowKickSayFallback = !strictElevenLabsOnly && (hearingDebugEffective || (!kickPhrase.playbackUrl && kickText.length > 0));
            this.logger.log(JSON.stringify({
                event: 'voice.runtime.url_summary',
                route: 'gather_deferred_kickoff',
                publicBaseUrl: originEarly,
                gatherActionUrl: deferPollUrl,
                playAudioUrl: kickPhrase.playbackUrl ?? null,
            }));
            const twimlKickoff = (0, gather_mvp_twiml_1.buildDeferredVoiceKickoffTwiML)({
                deferPollUrl,
                instantPlaybackUrl: kickPhrase.playbackUrl,
                allowTwilioSayFallback: allowKickSayFallback,
                instantSayText: !kickPhrase.playbackUrl && kickText.length > 0 ? kickText : undefined,
                language: this.getSessionLanguage(ctx),
            });
            this.logTwilioResponseMetrics('gather_deferred_kickoff', callSessionId, handlerStartedAt);
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.instant_ack_selected',
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                instantAckSelected: kickText.length > 0 ? kickText : '(silent)',
                ackReason: ackSelection.ackReason,
                letMeCheckUsedBefore,
                letMeCheckUsedAfter,
                intentDetected: userIntent,
            }));
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.gather_deferred_kickoff',
                callSessionId,
                agentId: ctx.agentId,
                tenantId: ctx.tenantId,
                jobId,
                speechPreview: speechText.slice(0, 200),
                voiceProviderActuallyUsed: kickPhrase.voiceProviderActuallyUsed,
                deferredKickoffPhrase: kickText.length > 0 ? kickText : null,
                responseDelayMs: Date.now() - handlerStartedAt,
                slowHandlerWarning: Date.now() - handlerStartedAt > 2000,
                'twilio.response_latency_ms': Date.now() - handlerStartedAt,
            }));
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.twiml_returned',
                route: 'gather_deferred_kickoff',
                callSessionId,
                agentResolved: true,
                twimlChars: twimlKickoff.length,
                playback: kickPhrase.playbackUrl ? 'elevenlabs_audio' : 'silent_or_twilio_say',
                ttsFallbackUsed: !kickPhrase.playbackUrl && kickText.length > 0,
                playbackChannel: kickPhrase.playbackUrl ? 'elevenlabs' : kickText.length > 0 ? 'twilio_say' : 'silent_redirect',
                replyVerb: kickPhrase.playbackUrl ? 'Play' : kickText.length > 0 ? 'Say' : 'Redirect',
                deferredPipeline: true,
                voiceProviderActuallyUsed: kickPhrase.voiceProviderActuallyUsed,
                'twilio.response_latency_ms': Date.now() - handlerStartedAt,
            }));
            return {
                twiml: twimlKickoff,
                callSessionId,
                agentResolved: true,
            };
        }
        const origin = this.getPublicBaseUrl();
        const gatherActionUrl = `${origin}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(callSessionId)}`;
        const gatherFallbackText = ctx.agent.fallbackMessage?.trim() ?? "We're having trouble hearing you. Please call again later. Goodbye.";
        const retryOpen = await this.resolveShortPhrasePlayUrl({
            origin,
            hearingDebugEffective,
            text: assistantResponse,
            tenantId: ctx.tenantId,
            callSessionId,
            agent: ctx.agent,
            logLabel: 'gather_retry_opening',
        });
        const retryFinal = await this.resolveShortPhrasePlayUrl({
            origin,
            hearingDebugEffective,
            text: gatherFallbackText,
            tenantId: ctx.tenantId,
            callSessionId,
            agent: ctx.agent,
            logLabel: 'gather_retry_final_fallback',
        });
        this.logger.log(JSON.stringify({
            event: 'voice.runtime.url_summary',
            route: 'gather',
            publicBaseUrl: origin,
            gatherActionUrl,
            playAudioUrl: retryOpen.playbackUrl ?? null,
        }));
        const twiml = (0, gather_mvp_twiml_1.buildInboundGatherMvpTwiML)({
            gatherActionUrl,
            language: this.getSessionLanguage(ctx),
            playbackAudioUrl: retryOpen.playbackUrl,
            finalFallbackAudioUrl: retryFinal.playbackUrl,
            openingSayText: strictElevenLabsOnly || retryOpen.playbackUrl ? undefined : assistantResponse,
            finalFallbackSayText: strictElevenLabsOnly || retryFinal.playbackUrl ? undefined : gatherFallbackText,
            timeoutSeconds: 5,
            speechTimeout: 'auto',
            pauseBeforeListenSeconds: 0,
            includePromptInsideGather: false,
        });
        const replyVerb = retryOpen.playbackUrl ? 'Play' : 'Say';
        this.logTwilioResponseMetrics('gather_retry_prompt', callSessionId, handlerStartedAt);
        console.log({
            speechResult: speechText.slice(0, 500),
            confidence,
            callSessionId,
            agentId: ctx.agentId,
            tenantId: ctx.tenantId,
            openaiCalled: false,
            openaiReply: assistantResponse.slice(0, 500),
            elevenLabsAudioCreated: Boolean(retryOpen.playbackUrl),
            replyVerb,
            twimlReplyVerb: replyVerb,
            ttsProviderUsed: retryOpen.playbackUrl ? 'elevenlabs' : 'twilio_say',
            voiceProviderActuallyUsedOpening: retryOpen.voiceProviderActuallyUsed,
            voiceProviderActuallyUsedFinalFallback: retryFinal.voiceProviderActuallyUsed,
            gatherRetrySayOnly: !retryOpen.playbackUrl,
        });
        console.log(JSON.stringify({
            event: 'twilio.voice.gather_reply_summary',
            loadedAgentId: ctx.agentId,
            dialedTo: maskPhoneForLog(payload.To),
            voiceProvider: ctx.agent.voiceProvider ?? null,
            voiceIdPresent: Boolean(ctx.agent.voiceId?.trim()),
            resolvedVoiceIdForElevenLabs: this.resolveElevenLabsVoiceId(ctx.agent) ? 'present' : 'missing',
            elevenLabsKeySource: gatherElevenLabsKeySource,
            providerUsed: retryOpen.playbackUrl ? 'elevenlabs' : 'twilio_say',
            callSessionId,
            nextGatherUrlIncludesCallSessionId: gatherActionUrl.includes('callSessionId='),
            SpeechResult: speechText.slice(0, 200),
            StableSpeechResult: (payload.StableSpeechResult ?? '').slice(0, 200),
            Confidence: payload.Confidence ?? '',
            replyVerb,
            replyUsedElevenLabsAudio: Boolean(retryOpen.playbackUrl),
            twimlHasRedirectToInbound: /<\s*Redirect/i.test(twiml),
        }));
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.twiml_returned',
            route: 'gather',
            callSessionId,
            agentResolved: true,
            twimlChars: twiml.length,
            playback: retryOpen.playbackUrl ? 'elevenlabs_audio' : 'twilio_say',
            ttsFallbackUsed: !retryOpen.playbackUrl,
            playbackChannel: retryOpen.playbackUrl ? 'elevenlabs' : 'twilio_say',
            replyVerb,
            voiceProviderActuallyUsedOpening: retryOpen.voiceProviderActuallyUsed,
            voiceProviderActuallyUsedFinalFallback: retryFinal.voiceProviderActuallyUsed,
            'twilio.response_latency_ms': Date.now() - handlerStartedAt,
        }));
        return {
            twiml,
            callSessionId,
            agentResolved: true,
        };
    }
    async handleDeferredVoicePoll(payload) {
        const handlerStartedAt = Date.now();
        let callSessionId = payload.callSessionId?.trim() ?? '';
        if (!callSessionId && payload.CallSid) {
            const session = await this.callsService.findOneByTwilioCallSid(payload.CallSid);
            callSessionId = session?.id ?? '';
        }
        const origin = this.getPublicBaseUrl();
        const deferPollUrl = `${origin}/api/twilio/voice/deferred-poll?callSessionId=${encodeURIComponent(callSessionId || 'missing')}`;
        if (!callSessionId) {
            const twiml = (0, conversation_relay_twiml_1.buildFallbackTwiML)("I'm sorry, I couldn't resume your call. Please try again.");
            this.logTwilioResponseMetrics('deferred_poll', undefined, handlerStartedAt);
            return { twiml, agentResolved: false };
        }
        const ctx = await this.sessionContext.load(callSessionId);
        if (!ctx) {
            const twiml = (0, conversation_relay_twiml_1.buildFallbackTwiML)("I'm sorry, I couldn't load your call session. Please try again.");
            this.logTwilioResponseMetrics('deferred_poll', callSessionId, handlerStartedAt);
            return { twiml, agentResolved: false };
        }
        const row = await this.callsService.findOneById(callSessionId);
        if (row.twilioCallSid && payload.CallSid !== row.twilioCallSid) {
            const twiml = (0, conversation_relay_twiml_1.buildFallbackTwiML)('Sorry, this call could not be verified. Please try again.');
            this.logger.warn(JSON.stringify({
                event: 'twilio.voice.deferred_poll_call_sid_mismatch',
                callSessionId,
            }));
            this.logTwilioResponseMetrics('deferred_poll_sid_mismatch', callSessionId, handlerStartedAt);
            return { twiml, callSessionId, agentResolved: false };
        }
        const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? row.metadata
            : {};
        const jobRaw = meta.deferredVoiceJob;
        const job = jobRaw && typeof jobRaw === 'object' && !Array.isArray(jobRaw) ? jobRaw : null;
        const gatherActionUrl = `${origin}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(callSessionId)}`;
        const gatherFallbackText = ctx.agent.fallbackMessage?.trim() ?? "We're having trouble hearing you. Please call again later. Goodbye.";
        const hearingDebug = this.isGatherHearingDebugMode();
        const hearingDebugEffective = this.resolveGatherHearingDebugEffective();
        const strictElevenLabsOnly = this.isStrictElevenLabsOnly();
        if (!job || !('phase' in job)) {
            const missOpen = "I didn't catch that. Could you repeat your question?";
            const missA = await this.resolveShortPhrasePlayUrl({
                origin,
                hearingDebugEffective,
                text: missOpen,
                tenantId: ctx.tenantId,
                callSessionId,
                agent: ctx.agent,
                logLabel: 'deferred_poll_missing_opening',
            });
            const missB = await this.resolveShortPhrasePlayUrl({
                origin,
                hearingDebugEffective,
                text: gatherFallbackText,
                tenantId: ctx.tenantId,
                callSessionId,
                agent: ctx.agent,
                logLabel: 'deferred_poll_missing_fallback',
            });
            this.logger.log(JSON.stringify({
                event: 'voice.runtime.url_summary',
                route: 'deferred_poll_recover',
                publicBaseUrl: origin,
                gatherActionUrl,
                playAudioUrl: missA.playbackUrl ?? null,
            }));
            const twiml = (0, gather_mvp_twiml_1.buildInboundGatherMvpTwiML)({
                gatherActionUrl,
                language: this.getSessionLanguage(ctx),
                playbackAudioUrl: missA.playbackUrl,
                finalFallbackAudioUrl: missB.playbackUrl,
                openingSayText: strictElevenLabsOnly || missA.playbackUrl ? undefined : missOpen,
                finalFallbackSayText: strictElevenLabsOnly || missB.playbackUrl ? undefined : gatherFallbackText,
                timeoutSeconds: 10,
                speechTimeout: '2',
                pauseBeforeListenSeconds: 0,
            });
            this.logTwilioResponseMetrics('deferred_poll_recover', callSessionId, handlerStartedAt);
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.deferred_poll_missing_job',
                callSessionId,
                voiceProviderActuallyUsedOpening: missA.voiceProviderActuallyUsed,
                voiceProviderActuallyUsedFinalFallback: missB.voiceProviderActuallyUsed,
                'twilio.response_latency_ms': Date.now() - handlerStartedAt,
            }));
            return { twiml, callSessionId, agentResolved: true };
        }
        if (job.phase === 'processing') {
            const elapsed = Date.now() - job.startedAtMs;
            if (elapsed > 120_000) {
                await this.callsService.mergeSessionMetadata(callSessionId, { deferredVoiceJob: null });
                const timeoutOpen = ctx.agent.fallbackMessage?.trim() ?? "I'm sorry, that took too long. Please try your question again.";
                const toA = await this.resolveShortPhrasePlayUrl({
                    origin,
                    hearingDebugEffective,
                    text: timeoutOpen,
                    tenantId: ctx.tenantId,
                    callSessionId,
                    agent: ctx.agent,
                    logLabel: 'deferred_poll_timeout_opening',
                });
                const toB = await this.resolveShortPhrasePlayUrl({
                    origin,
                    hearingDebugEffective,
                    text: gatherFallbackText,
                    tenantId: ctx.tenantId,
                    callSessionId,
                    agent: ctx.agent,
                    logLabel: 'deferred_poll_timeout_fallback',
                });
                this.logger.log(JSON.stringify({
                    event: 'voice.runtime.url_summary',
                    route: 'deferred_poll_timeout',
                    publicBaseUrl: origin,
                    gatherActionUrl,
                    playAudioUrl: toA.playbackUrl ?? null,
                }));
                const twiml = (0, gather_mvp_twiml_1.buildInboundGatherMvpTwiML)({
                    gatherActionUrl,
                    language: this.getSessionLanguage(ctx),
                    playbackAudioUrl: toA.playbackUrl,
                    finalFallbackAudioUrl: toB.playbackUrl,
                    openingSayText: strictElevenLabsOnly || toA.playbackUrl ? undefined : timeoutOpen,
                    finalFallbackSayText: strictElevenLabsOnly || toB.playbackUrl ? undefined : gatherFallbackText,
                    timeoutSeconds: 10,
                    speechTimeout: '2',
                    pauseBeforeListenSeconds: 0,
                });
                this.logTwilioResponseMetrics('deferred_poll_timeout', callSessionId, handlerStartedAt);
                return { twiml, callSessionId, agentResolved: true };
            }
            if (elapsed > 1500 && !job.momentPromptPlayed) {
                const fillerAlready = meta.fillerUsed === true;
                await this.callsService.mergeSessionMetadata(callSessionId, {
                    deferredVoiceJob: { ...job, momentPromptPlayed: true },
                    ...(fillerAlready ? {} : { fillerUsed: true }),
                });
                if (fillerAlready) {
                    const twiml = (0, gather_mvp_twiml_1.buildDeferredVoicePollPauseTwiML)({ deferPollUrl, pauseSeconds: 1 });
                    this.logTwilioResponseMetrics('deferred_poll_pause_skip_filler', callSessionId, handlerStartedAt);
                    this.logger.log(JSON.stringify({
                        event: 'twilio.voice.deferred_poll',
                        sub: 'pause_filler_already_used',
                        callSessionId,
                        elapsedMs: elapsed,
                        fillerUsed: true,
                        'twilio.response_latency_ms': Date.now() - handlerStartedAt,
                    }));
                    return { twiml, callSessionId, agentResolved: true };
                }
                const moment = await this.withTimeout(this.resolveShortPhrasePlayUrl({
                    origin,
                    hearingDebugEffective,
                    text: 'Just a moment.',
                    tenantId: ctx.tenantId,
                    callSessionId,
                    agent: ctx.agent,
                    logLabel: 'deferred_poll_processing_filler',
                }), 900, { voiceProviderActuallyUsed: 'twilio_say_fallback' });
                const twiml = (0, gather_mvp_twiml_1.buildDeferredVoiceMomentPleaseTwiML)({
                    deferPollUrl,
                    playbackUrl: moment.playbackUrl,
                    sayFallbackText: 'Just a moment.',
                    allowTwilioSayFallback: !strictElevenLabsOnly,
                    language: this.getSessionLanguage(ctx),
                });
                this.logTwilioResponseMetrics('deferred_poll_moment', callSessionId, handlerStartedAt);
                this.logger.log(JSON.stringify({
                    event: 'twilio.voice.deferred_poll',
                    sub: 'processing_filler',
                    callSessionId,
                    voiceProviderActuallyUsed: moment.voiceProviderActuallyUsed,
                    fillerUsed: true,
                    responseDelayMs: elapsed,
                    'twilio.response_latency_ms': Date.now() - handlerStartedAt,
                }));
                return { twiml, callSessionId, agentResolved: true };
            }
            const twiml = (0, gather_mvp_twiml_1.buildDeferredVoicePollPauseTwiML)({ deferPollUrl, pauseSeconds: 1 });
            this.logTwilioResponseMetrics('deferred_poll_pause', callSessionId, handlerStartedAt);
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.deferred_poll',
                sub: 'pause',
                callSessionId,
                elapsedMs: elapsed,
                'twilio.response_latency_ms': Date.now() - handlerStartedAt,
            }));
            return { twiml, callSessionId, agentResolved: true };
        }
        if (job.phase === 'failed') {
            await this.callsService.mergeSessionMetadata(callSessionId, { deferredVoiceJob: null });
            const msg = ctx.agent.fallbackMessage ?? "I'm having trouble right now. Please call back later.";
            const failA = await this.resolveShortPhrasePlayUrl({
                origin,
                hearingDebugEffective,
                text: msg,
                tenantId: ctx.tenantId,
                callSessionId,
                agent: ctx.agent,
                logLabel: 'deferred_poll_failed_opening',
            });
            const failB = await this.resolveShortPhrasePlayUrl({
                origin,
                hearingDebugEffective,
                text: gatherFallbackText,
                tenantId: ctx.tenantId,
                callSessionId,
                agent: ctx.agent,
                logLabel: 'deferred_poll_failed_fallback',
            });
            this.logger.log(JSON.stringify({
                event: 'voice.runtime.url_summary',
                route: 'deferred_poll_failed',
                publicBaseUrl: origin,
                gatherActionUrl,
                playAudioUrl: failA.playbackUrl ?? null,
            }));
            const twiml = (0, gather_mvp_twiml_1.buildInboundGatherMvpTwiML)({
                gatherActionUrl,
                language: this.getSessionLanguage(ctx),
                playbackAudioUrl: failA.playbackUrl,
                finalFallbackAudioUrl: failB.playbackUrl,
                openingSayText: strictElevenLabsOnly || failA.playbackUrl ? undefined : msg,
                finalFallbackSayText: strictElevenLabsOnly || failB.playbackUrl ? undefined : gatherFallbackText,
                timeoutSeconds: 10,
                speechTimeout: '2',
                pauseBeforeListenSeconds: 0,
            });
            this.logTwilioResponseMetrics('deferred_poll_failed', callSessionId, handlerStartedAt);
            return { twiml, callSessionId, agentResolved: true };
        }
        await this.callsService.mergeSessionMetadata(callSessionId, { deferredVoiceJob: null });
        const playbackAudioUrl = job.playbackUrl?.trim() || undefined;
        const readyFall = await this.resolveShortPhrasePlayUrl({
            origin,
            hearingDebugEffective,
            text: gatherFallbackText,
            tenantId: ctx.tenantId,
            callSessionId,
            agent: ctx.agent,
            logLabel: 'deferred_poll_ready_final_fallback',
        });
        this.logger.log(JSON.stringify({
            event: 'voice.runtime.url_summary',
            route: 'deferred_poll_ready',
            publicBaseUrl: origin,
            gatherActionUrl,
            playAudioUrl: playbackAudioUrl ?? null,
        }));
        const twiml = (0, gather_mvp_twiml_1.buildInboundGatherMvpTwiML)({
            gatherActionUrl,
            language: this.getSessionLanguage(ctx),
            playbackAudioUrl,
            finalFallbackAudioUrl: readyFall.playbackUrl,
            openingSayText: strictElevenLabsOnly || playbackAudioUrl ? undefined : job.assistantResponse,
            finalFallbackSayText: strictElevenLabsOnly || readyFall.playbackUrl ? undefined : gatherFallbackText,
            timeoutSeconds: 10,
            speechTimeout: '2',
            pauseBeforeListenSeconds: 0,
        });
        this.logTwilioResponseMetrics('deferred_poll_ready', callSessionId, handlerStartedAt);
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.deferred_poll',
            sub: 'ready',
            callSessionId,
            playback: playbackAudioUrl ? 'elevenlabs_audio' : 'twilio_say',
            usedElevenLabs: job.usedElevenLabs,
            tts_generation_time_ms: job.ttsGenerationTimeMs,
            audioBytes: job.audioBytes ?? null,
            voiceProviderActuallyUsedMain: playbackAudioUrl ? 'elevenlabs' : 'twilio_say_fallback',
            voiceProviderActuallyUsedFinalFallback: readyFall.voiceProviderActuallyUsed,
            'twilio.response_latency_ms': Date.now() - handlerStartedAt,
        }));
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.twiml_returned',
            route: 'deferred_poll_ready',
            callSessionId,
            agentResolved: true,
            twimlChars: twiml.length,
            playback: playbackAudioUrl ? 'elevenlabs_audio' : 'twilio_say',
            replyVerb: playbackAudioUrl ? 'Play' : 'Say',
            voiceProviderActuallyUsedFinalFallback: readyFall.voiceProviderActuallyUsed,
            'twilio.response_latency_ms': Date.now() - handlerStartedAt,
        }));
        return {
            twiml,
            callSessionId,
            agentResolved: true,
        };
    }
    logTwilioResponseMetrics(route, callSessionId, startedAt) {
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.response_metrics',
            route,
            callSessionId: callSessionId ?? null,
            'twilio.response_latency_ms': Date.now() - startedAt,
        }));
    }
    kickDeferredVoiceProcessing(callSessionId, speechText, jobId) {
        void this.runDeferredVoiceJob(callSessionId, speechText, jobId).catch((err) => {
            this.logger.error(JSON.stringify({
                event: 'voice.deferred.job_unhandled',
                callSessionId,
                jobId,
                message: err instanceof Error ? err.message.slice(0, 300) : 'unknown_error',
            }));
            void this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, err instanceof Error ? err.message.slice(0, 300) : 'unknown_error');
        });
    }
    async failDeferredVoiceJobIfCurrent(callSessionId, jobId, errorMessage) {
        const row = await this.callsService.findOneById(callSessionId);
        const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? row.metadata
            : {};
        const cur = meta.deferredVoiceJob;
        if (!cur || cur.jobId !== jobId || cur.phase !== 'processing') {
            return;
        }
        await this.callsService.mergeSessionMetadata(callSessionId, {
            deferredVoiceJob: {
                jobId,
                phase: 'failed',
                startedAtMs: cur.startedAtMs,
                errorMessage,
            },
        });
    }
    async runDeferredVoiceJob(callSessionId, speechText, jobId) {
        const budgetRaw = this.config.get('VOICE_DEFERRED_JOB_TIMEOUT_MS') ?? process.env.VOICE_DEFERRED_JOB_TIMEOUT_MS ?? '';
        const parsed = Number(budgetRaw.trim());
        const budgetMs = Number.isFinite(parsed)
            ? Math.min(120_000, Math.max(VOICE_DEFERRED_JOB_TIMEOUT_MS_MIN, parsed))
            : 55_000;
        try {
            await Promise.race([
                this.executeDeferredVoiceJobBody(callSessionId, speechText, jobId),
                new Promise((_, reject) => setTimeout(() => reject(new Error('VOICE_DEFERRED_JOB_TIMEOUT')), budgetMs)),
            ]);
        }
        catch (err) {
            if (err instanceof Error && err.message === 'VOICE_DEFERRED_JOB_TIMEOUT') {
                this.logger.warn(JSON.stringify({
                    event: 'voice.deferred.job_timeout',
                    callSessionId,
                    jobId,
                    budgetMs,
                    note: 'OpenAI or Shopify tools exceeded budget; failing job so deferred-poll can recover.',
                }));
                await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, 'processing_timeout');
                return;
            }
            const message = err instanceof Error ? err.message.slice(0, 300) : 'unknown_error';
            this.logger.error(JSON.stringify({
                event: 'voice.deferred.job_fatal',
                callSessionId,
                jobId,
                message,
            }));
            await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, message);
        }
    }
    async executeDeferredVoiceJobBody(callSessionId, speechText, jobId) {
        const ctx = await this.sessionContext.load(callSessionId);
        if (!ctx) {
            await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, 'session_context_missing');
            return;
        }
        if (await this.streamingSession.isBargeInRequested(callSessionId)) {
            await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, 'barge_in_interrupted');
            return;
        }
        try {
            const llmStarted = Date.now();
            const utter = await this.voiceRuntime.processUtterance(callSessionId, speechText, []);
            const llmLatencyMs = Date.now() - llmStarted;
            const assistantResponse = utter.reply;
            const proof = utter.turnProof;
            await this.streamMetrics.merge(callSessionId, {
                llmLatencyMs,
                streamingStatus: 'processing',
                toolLatencyMs: typeof proof?.responseDelayMs === 'number' ? proof.responseDelayMs : llmLatencyMs,
            });
            if (typeof proof?.openaiUsed === 'boolean') {
                await this.voiceCost.recordOpenAiUsage(callSessionId, {
                    promptTokens: 800,
                    completionTokens: Math.ceil(assistantResponse.length / 4),
                });
            }
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.llm_reply_generated',
                eventJourney: 'voice.journey.twilio_llm_reply_ready',
                callSessionId,
                tenantId: ctx.tenantId,
                replyChars: assistantResponse.length,
                turnProof: utter.turnProof ?? null,
                deferredJobId: jobId,
            }));
            if (await this.streamingSession.isBargeInRequested(callSessionId)) {
                await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, 'barge_in_interrupted');
                return;
            }
            const origin = this.getPublicBaseUrl();
            const voiceOpts = {
                callSessionId,
                tenantId: ctx.tenantId,
                phase: 'gather_reply',
                voiceId: this.resolveElevenLabsVoiceId(ctx.agent),
                elevenlabsApiKey: ctx.agent.elevenlabsApiKey ?? undefined,
                elevenlabsModel: ctx.agent.elevenlabsModel ?? undefined,
                voiceStyle: ctx.agent.voiceStyle ?? undefined,
            };
            const firstChunkText = (0, voice_response_chunker_util_1.firstSpeakableChunk)(assistantResponse);
            const ttsStart = Date.now();
            const [firstChunkTts, tts] = await Promise.all([
                firstChunkText.length < assistantResponse.length
                    ? this.buildElevenLabsPlaybackUrl(origin, firstChunkText, voiceOpts)
                    : Promise.resolve({ playbackUrl: undefined }),
                this.buildElevenLabsPlaybackUrl(origin, assistantResponse, voiceOpts),
            ]);
            const ttsGenerationTimeMs = tts.tts_generation_time_ms ?? Date.now() - ttsStart;
            await this.voiceCost.recordElevenLabsUsage(callSessionId, assistantResponse.length);
            await this.streamMetrics.merge(callSessionId, {
                ttsLatencyMs: ttsGenerationTimeMs,
                chunksEmitted: Math.max(1, firstChunkText.length < assistantResponse.length ? 2 : 1),
                streamingStatus: 'speaking',
                agentSpeaking: true,
            });
            const row = await this.callsService.findOneById(callSessionId);
            const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
                ? row.metadata
                : {};
            const cur = meta.deferredVoiceJob;
            if (!cur || cur.jobId !== jobId || cur.phase !== 'processing') {
                this.logger.warn(JSON.stringify({
                    event: 'voice.deferred.stale_completion',
                    callSessionId,
                    jobId,
                }));
                return;
            }
            await this.callsService.mergeSessionMetadata(callSessionId, {
                deferredVoiceJob: {
                    jobId,
                    phase: 'ready',
                    startedAtMs: cur.startedAtMs,
                    momentPromptPlayed: cur.momentPromptPlayed,
                    assistantResponse,
                    playbackUrl: tts.playbackUrl,
                    firstChunkPlaybackUrl: 'playbackUrl' in firstChunkTts ? firstChunkTts.playbackUrl : undefined,
                    usedElevenLabs: Boolean(tts.playbackUrl),
                    audioBytes: tts.audioBytes,
                    ttsGenerationTimeMs,
                    streamingEnabled: true,
                },
            });
            await this.streamingSession.clearBargeIn(callSessionId);
            const responseDelayMs = Date.now() - cur.startedAtMs;
            const fillerUsedLog = meta.fillerUsed === true;
            this.logger.log(JSON.stringify({
                event: 'voice.deferred.job_ready',
                callSessionId,
                jobId,
                tts_generation_time_ms: ttsGenerationTimeMs,
                usedElevenLabs: Boolean(tts.playbackUrl),
                audioBytes: tts.audioBytes ?? null,
                responseDelayMs,
                fillerUsed: fillerUsedLog,
            }));
        }
        catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 300) : 'unknown_error';
            this.logger.error(JSON.stringify({
                event: 'twilio.voice.llm_reply_failed',
                callSessionId,
                jobId,
                message,
                deferred: true,
            }));
            const stall = (0, streaming_fallback_util_1.stallAcknowledgement)(message.includes('timeout') ? 'processing_timeout' : 'openai_slow');
            await this.callsService.mergeSessionMetadata(callSessionId, {
                lastStallPhrase: stall,
            });
            await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, message);
        }
    }
    resolveElevenLabsVoiceId(agent) {
        void agent.voiceProvider;
        const vid = agent.voiceId?.trim();
        if (!vid)
            return undefined;
        return vid;
    }
    async withTimeout(promise, ms, fallback) {
        return new Promise((resolve) => {
            const t = setTimeout(() => resolve(fallback), ms);
            promise
                .then((v) => {
                clearTimeout(t);
                resolve(v);
            })
                .catch(() => {
                clearTimeout(t);
                resolve(fallback);
            });
        });
    }
    async resolveElevenLabsApiKeyAndSource(tenantId, secretsEnc, agentId) {
        let agentPlain = null;
        if (secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(secretsEnc);
            if (dec) {
                try {
                    const secrets = JSON.parse(dec);
                    agentPlain = typeof secrets.elevenlabsApiKey === 'string' ? secrets.elevenlabsApiKey : null;
                }
                catch {
                }
            }
        }
        const ti = this.encryption.isAvailable()
            ? await this.prisma.tenantIntegration.findUnique({
                where: { tenantId },
                select: { elevenlabsApiKeyEnc: true },
            })
            : null;
        const workspaceFlags = await this.loadAgentWorkspaceFlags(agentId);
        const r = (0, voice_config_resolution_util_1.resolveElevenLabsKeyChain)({
            agentSecretPlain: agentPlain,
            tenantEnc: ti?.elevenlabsApiKeyEnc ?? null,
            decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
            envPlain: (0, provider_env_slice_util_1.gatedProcessEnv)('ELEVENLABS_API_KEY', this.config),
            encryptionAvailable: this.encryption.isAvailable(),
            useWorkspaceElevenlabs: workspaceFlags.useWorkspaceElevenlabs,
        });
        return { apiKey: r.value ?? undefined, keySource: r.source };
    }
    async loadElevenLabsTtsOptions(context) {
        let model;
        let workspaceDefaultVoiceId = null;
        const row = await this.prisma.agent.findUnique({
            where: { id: context.agentId },
            select: {
                secretsEnc: true,
                voiceId: true,
                voiceProvider: true,
                voiceProfile: { select: { providerConfig: true } },
            },
        });
        const { apiKey: elevenlabsApiKey, keySource } = await this.resolveElevenLabsApiKeyAndSource(context.tenantId, row?.secretsEnc, context.agentId);
        if (this.encryption.isAvailable()) {
            const ti = await this.prisma.tenantIntegration.findUnique({
                where: { tenantId: context.tenantId },
                select: {
                    elevenlabsDefaultModel: true,
                    elevenlabsDefaultVoiceId: true,
                },
            });
            workspaceDefaultVoiceId = ti?.elevenlabsDefaultVoiceId?.trim() || null;
            if (ti?.elevenlabsDefaultModel?.trim())
                model = ti.elevenlabsDefaultModel.trim();
        }
        const pc = row?.voiceProfile?.providerConfig;
        if (pc?.elevenlabsModel?.trim())
            model = pc.elevenlabsModel.trim();
        const voiceIdMerged = row?.voiceId?.trim() || workspaceDefaultVoiceId || undefined;
        const voiceId = voiceIdMerged || undefined;
        return { apiKey: elevenlabsApiKey, model, voiceId, keySource };
    }
    async buildElevenLabsPlaybackUrl(publicOrigin, text, opts) {
        const hasBaseUrl = /^https:\/\//i.test(publicOrigin);
        const elevenLabsApiKeySet = Boolean((opts.elevenlabsApiKey ?? this.config.get('ELEVENLABS_API_KEY') ?? '').trim());
        if (!hasBaseUrl || !elevenLabsApiKeySet) {
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.tts_fallback',
                phase: opts.phase,
                callSessionId: opts.callSessionId,
                reason: !hasBaseUrl ? 'public_webhook_base_url_not_https' : 'elevenlabs_api_key_missing',
            }));
            return {};
        }
        const ttsStart = Date.now();
        try {
            const prep = (0, voice_reply_tts_shorten_util_1.shortenReplyForVoiceTts)(text, voice_reply_tts_shorten_util_1.VOICE_REPLY_TTS_MAX_CHARS);
            this.logger.log(JSON.stringify({
                event: 'voice.tts_text_prepared',
                phase: opts.phase,
                callSessionId: opts.callSessionId,
                'voice.reply_shortened': prep.reply_shortened,
                originalChars: prep.originalChars,
                finalChars: prep.finalChars,
            }));
            const audio = await this.elevenLabs.textToSpeech(prep.text, opts.voiceId, {
                apiKey: opts.elevenlabsApiKey,
                modelId: opts.elevenlabsModel,
                styleNotes: opts.voiceStyle,
            });
            const tts_generation_time_ms = Date.now() - ttsStart;
            if (audio.length > voice_reply_tts_shorten_util_1.VOICE_TTS_MAX_AUDIO_BYTES) {
                this.logger.warn(JSON.stringify({
                    event: 'twilio.voice.tts_oversize_discarded',
                    phase: opts.phase,
                    callSessionId: opts.callSessionId,
                    audioBytes: audio.length,
                    maxBytes: voice_reply_tts_shorten_util_1.VOICE_TTS_MAX_AUDIO_BYTES,
                    tts_generation_time_ms,
                }));
                return { audioBytes: audio.length, tts_generation_time_ms };
            }
            const token = this.ttsCache.put(audio);
            const playbackUrl = `${publicOrigin}/api/twilio/voice/tts/${encodeURIComponent(token)}`;
            this.logger.log(JSON.stringify({
                event: 'twilio.voice.elevenlabs_audio_generated',
                phase: opts.phase,
                callSessionId: opts.callSessionId,
                audioBytes: audio.length,
                'voice.reply_shortened': prep.reply_shortened,
                ttsInputChars: prep.finalChars,
                tts_generation_time_ms,
            }));
            return { playbackUrl, audioBytes: audio.length, tts_generation_time_ms };
        }
        catch (err) {
            const tts_generation_time_ms = Date.now() - ttsStart;
            const message = err instanceof Error ? err.message.slice(0, 300) : 'unknown_error';
            this.logger.warn(JSON.stringify({
                event: 'twilio.voice.tts_fallback',
                phase: opts.phase,
                callSessionId: opts.callSessionId,
                reason: 'elevenlabs_request_failed',
                message,
                nextPlayback: 'openai_voice_or_safe_default',
                tts_generation_time_ms,
            }));
            await this.callEvents.log(opts.tenantId, opts.callSessionId, client_1.CallEventType.FALLBACK_USED, {
                reason: 'elevenlabs_tts_failed',
                phase: opts.phase,
                message,
            });
            return { tts_generation_time_ms };
        }
    }
};
exports.TwilioWebhookService = TwilioWebhookService;
exports.TwilioWebhookService = TwilioWebhookService = TwilioWebhookService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        agent_resolution_service_1.AgentResolutionService,
        calls_service_1.CallsService,
        call_events_service_1.CallEventsService,
        voice_runtime_service_1.VoiceRuntimeService,
        session_context_service_1.SessionContextService,
        transcript_buffer_service_1.TranscriptBufferService,
        elevenlabs_service_1.ElevenLabsService,
        twilio_tts_cache_service_1.TwilioTtsCacheService,
        voice_prompt_audio_service_1.VoicePromptAudioService,
        prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService,
        voice_stream_metrics_service_1.VoiceStreamMetricsService,
        voice_cost_analytics_service_1.VoiceCostAnalyticsService,
        voice_streaming_session_service_1.VoiceStreamingSessionService,
        elevenlabs_streaming_service_1.ElevenLabsStreamingService])
], TwilioWebhookService);
//# sourceMappingURL=twilio-webhook.service.js.map