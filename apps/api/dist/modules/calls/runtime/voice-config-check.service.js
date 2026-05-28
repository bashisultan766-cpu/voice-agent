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
exports.VoiceConfigCheckService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../../database/prisma.service");
const encryption_service_1 = require("../../../common/encryption.service");
const public_webhook_base_url_1 = require("../../../common/public-webhook-base-url");
const normalize_phone_1 = require("../../integrations/twilio/utils/normalize-phone");
const voice_config_resolution_util_1 = require("./voice-config-resolution.util");
const provider_env_slice_util_1 = require("../../../common/provider-env-slice.util");
let VoiceConfigCheckService = class VoiceConfigCheckService {
    constructor(prisma, encryption, config) {
        this.prisma = prisma;
        this.encryption = encryption;
        this.config = config;
    }
    async check(tenantId, agentId) {
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                id: true,
                model: true,
                voiceProvider: true,
                voiceId: true,
                twilioPhoneNumber: true,
                secretsEnc: true,
                agentConfig: {
                    select: { useWorkspaceOpenai: true, useWorkspaceElevenlabs: true },
                },
            },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const useWorkspaceOpenai = agent.agentConfig?.useWorkspaceOpenai === true;
        const useWorkspaceElevenlabs = agent.agentConfig?.useWorkspaceElevenlabs === true;
        const warnings = [];
        let agentOpenaiPlain = null;
        let agentElevenPlain = null;
        if (agent.secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(agent.secretsEnc);
            if (dec) {
                try {
                    const secrets = JSON.parse(dec);
                    agentOpenaiPlain = typeof secrets.openaiApiKey === 'string' ? secrets.openaiApiKey : null;
                    agentElevenPlain = typeof secrets.elevenlabsApiKey === 'string' ? secrets.elevenlabsApiKey : null;
                }
                catch {
                    warnings.push('agent_secretsEnc_not_json');
                }
            }
        }
        const ti = this.encryption.isAvailable()
            ? await this.prisma.tenantIntegration.findUnique({
                where: { tenantId },
                select: { openaiApiKeyEnc: true, elevenlabsApiKeyEnc: true, elevenlabsDefaultVoiceId: true },
            })
            : null;
        const encAvail = this.encryption.isAvailable();
        if (!encAvail) {
            warnings.push('encryption_not_configured_tenant_keys_unreadable');
        }
        const openaiEnvPlain = (0, provider_env_slice_util_1.gatedProcessEnv)('OPENAI_API_KEY', this.config);
        const openaiR = (0, voice_config_resolution_util_1.resolveOpenAiKeyChain)({
            agentSecretPlain: agentOpenaiPlain,
            tenantEnc: ti?.openaiApiKeyEnc ?? null,
            decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
            envPlain: openaiEnvPlain,
            encryptionAvailable: encAvail,
            useWorkspaceOpenai,
        });
        const openaiLayers = (0, voice_config_resolution_util_1.openAiKeyLayerPresence)({
            agentSecretPlain: agentOpenaiPlain,
            tenantEnc: ti?.openaiApiKeyEnc ?? null,
            envPlain: openaiEnvPlain,
            useWorkspaceOpenai,
        });
        const agentOpenaiKeyStored = openaiLayers.agentKeyPresent;
        const tenantOpenaiKeyStored = openaiLayers.tenantKeyPresent;
        const envKeyPresent = openaiLayers.envKeyPresent;
        const agentOverridesWorkspaceOpenai = agentOpenaiKeyStored && tenantOpenaiKeyStored;
        const elevenR = (0, voice_config_resolution_util_1.resolveElevenLabsKeyChain)({
            agentSecretPlain: agentElevenPlain,
            tenantEnc: ti?.elevenlabsApiKeyEnc ?? null,
            decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
            envPlain: (0, provider_env_slice_util_1.gatedProcessEnv)('ELEVENLABS_API_KEY', this.config),
            encryptionAvailable: encAvail,
            useWorkspaceElevenlabs,
        });
        if (agentOverridesWorkspaceOpenai) {
            warnings.push('agent_openai_key_overrides_workspace_openai_key');
        }
        if (elevenR.source === 'agent' && ti?.elevenlabsApiKeyEnc) {
            warnings.push('workspace_elevenlabs_key_is_saved_but_per_agent_secret_takes_precedence');
        }
        const normalizedTwilio = agent.twilioPhoneNumber?.trim() ? (0, normalize_phone_1.normalizePhoneNumber)(agent.twilioPhoneNumber.trim()) : null;
        const mappingCount = normalizedTwilio
            ? await this.prisma.phoneNumberMapping.count({
                where: { tenantId, phoneNumber: normalizedTwilio, agentId: agent.id },
            })
            : 0;
        const twilioNumberMapped = Boolean(normalizedTwilio && mappingCount > 0);
        if (normalizedTwilio && !twilioNumberMapped) {
            warnings.push('twilio_number_on_agent_not_found_in_phone_number_mapping');
        }
        const publicWebhookBaseUrlValid = (0, public_webhook_base_url_1.validatePublicWebhookBaseUrl)(this.config.get('PUBLIC_WEBHOOK_BASE_URL')).ok;
        if (!publicWebhookBaseUrlValid) {
            warnings.push('public_webhook_base_url_must_be_https_for_elevenlabs_playback');
        }
        const gatherDebugRaw = `${this.config.get('TWILIO_GATHER_HEARING_DEBUG') ?? process.env.TWILIO_GATHER_HEARING_DEBUG ?? ''}`.trim();
        const twilioGatherHearingDebug = gatherDebugRaw === '1' || gatherDebugRaw.toLowerCase() === 'true';
        const forceElRaw = `${this.config.get('FORCE_ELEVENLABS_ONLY') ?? process.env.FORCE_ELEVENLABS_ONLY ?? ''}`.trim();
        const forceElevenLabsOnly = forceElRaw === '1' || forceElRaw.toLowerCase() === 'true';
        if (twilioGatherHearingDebug) {
            warnings.push('TWILIO_GATHER_HEARING_DEBUG=true: fixed Gather prompts can use Twilio <Say> (Polly) instead of ElevenLabs <Play>, which disables ElevenLabs for those scripted lines and often sounds like a second voice in production.');
            if (forceElevenLabsOnly) {
                warnings.push('FORCE_ELEVENLABS_ONLY=true overrides TWILIO_GATHER_HEARING_DEBUG for scripted prompts: ElevenLabs <Play> is still used unless ElevenLabs fails, the ElevenLabs voice ID is missing, or PUBLIC_WEBHOOK_BASE_URL is not HTTPS.');
            }
        }
        else if (forceElevenLabsOnly) {
            warnings.push('FORCE_ELEVENLABS_ONLY=true: customer-facing speech should use ElevenLabs <Play> with the configured voice ID; Twilio <Say> is only used as an explicit fallback when ElevenLabs cannot run.');
        }
        const workspaceDefaultVoice = ti?.elevenlabsDefaultVoiceId?.trim() || null;
        const voiceIdEffective = agent.voiceId?.trim() || workspaceDefaultVoice;
        const vp = (agent.voiceProvider ?? '').toLowerCase().trim();
        return {
            resolvedAgentId: agent.id,
            tenantId,
            openaiKeySource: openaiR.source,
            openaiKeyPresent: Boolean(openaiR.value?.trim()),
            agentOpenaiKeyStored,
            tenantOpenaiKeyStored,
            agentKeyPresent: agentOpenaiKeyStored,
            tenantKeyPresent: tenantOpenaiKeyStored,
            envKeyPresent,
            agentOverridesWorkspaceOpenai,
            model: agent.model ?? null,
            voiceProvider: agent.voiceProvider ?? null,
            voiceIdPresent: Boolean(vp === 'elevenlabs' && voiceIdEffective),
            elevenLabsKeySource: elevenR.source,
            publicWebhookBaseUrlValid,
            twilioNumberMapped,
            warnings,
        };
    }
};
exports.VoiceConfigCheckService = VoiceConfigCheckService;
exports.VoiceConfigCheckService = VoiceConfigCheckService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService,
        config_1.ConfigService])
], VoiceConfigCheckService);
//# sourceMappingURL=voice-config-check.service.js.map