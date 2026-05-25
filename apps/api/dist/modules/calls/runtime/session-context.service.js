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
var SessionContextService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionContextService = void 0;
const common_1 = require("@nestjs/common");
const types_1 = require("@bookstore-voice-agents/types");
const prisma_service_1 = require("../../../database/prisma.service");
const encryption_service_1 = require("../../../common/encryption.service");
const voice_config_resolution_util_1 = require("./voice-config-resolution.util");
let SessionContextService = SessionContextService_1 = class SessionContextService {
    constructor(prisma, encryption) {
        this.prisma = prisma;
        this.encryption = encryption;
        this.log = new common_1.Logger(SessionContextService_1.name);
    }
    async load(callSessionId) {
        const session = await this.prisma.callSession.findUnique({
            where: { id: callSessionId },
            include: {
                agent: { include: { agentConfig: true, voiceProfile: true } },
                store: {
                    include: {
                        shopifyConnection: { select: { id: true, shopDomain: true, accessTokenEnc: true } },
                    },
                },
            },
        });
        if (!session)
            return null;
        const store = session.store;
        const storeName = store?.name ?? session.agent.storeName ?? 'Store';
        const storeCity = store?.city ?? null;
        const storeTimezone = store?.timezone ?? session.agent.timezone ?? null;
        let agentOpenaiPlain = null;
        let agentElevenPlain = null;
        let shopifyAdminToken = null;
        let workspaceElevenlabsDefaultVoiceId = null;
        let workspaceElevenlabsDefaultModel = null;
        let tiOpenaiEnc = null;
        let tiElevenEnc = null;
        if (session.agent.secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(session.agent.secretsEnc);
            if (dec) {
                try {
                    const secrets = JSON.parse(dec);
                    agentOpenaiPlain = typeof secrets.openaiApiKey === 'string' ? secrets.openaiApiKey : null;
                    agentElevenPlain = typeof secrets.elevenlabsApiKey === 'string' ? secrets.elevenlabsApiKey : null;
                    shopifyAdminToken =
                        typeof secrets.shopifyAdminToken === 'string'
                            ? secrets.shopifyAdminToken
                            : null;
                }
                catch {
                }
            }
        }
        if (!shopifyAdminToken?.trim() && store?.shopifyConnection?.accessTokenEnc && this.encryption.isAvailable()) {
            const decTok = this.encryption.decryptFromStorage(store.shopifyConnection.accessTokenEnc);
            if (decTok?.trim())
                shopifyAdminToken = decTok.trim();
        }
        if (this.encryption.isAvailable()) {
            const ti = await this.prisma.tenantIntegration.findUnique({
                where: { tenantId: session.tenantId },
                select: {
                    openaiApiKeyEnc: true,
                    elevenlabsApiKeyEnc: true,
                    elevenlabsDefaultModel: true,
                    elevenlabsDefaultVoiceId: true,
                },
            });
            workspaceElevenlabsDefaultVoiceId = ti?.elevenlabsDefaultVoiceId?.trim() || null;
            workspaceElevenlabsDefaultModel = ti?.elevenlabsDefaultModel?.trim() || null;
            tiOpenaiEnc = ti?.openaiApiKeyEnc ?? null;
            tiElevenEnc = ti?.elevenlabsApiKeyEnc ?? null;
        }
        const encAvail = this.encryption.isAvailable();
        const openaiResolved = (0, voice_config_resolution_util_1.resolveOpenAiKeyChain)({
            agentSecretPlain: agentOpenaiPlain,
            tenantEnc: tiOpenaiEnc,
            decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
            envPlain: process.env.OPENAI_API_KEY,
            encryptionAvailable: encAvail,
        });
        const openaiLayers = (0, voice_config_resolution_util_1.openAiKeyLayerPresence)({
            agentSecretPlain: agentOpenaiPlain,
            tenantEnc: tiOpenaiEnc,
            envPlain: process.env.OPENAI_API_KEY,
        });
        const openaiKeySource = openaiResolved.source;
        console.log({
            openaiKeySource,
            agentKeyPresent: openaiLayers.agentKeyPresent,
            tenantKeyPresent: openaiLayers.tenantKeyPresent,
            envKeyPresent: openaiLayers.envKeyPresent,
            callSessionId: session.id,
            agentId: session.agentId,
            tenantId: session.tenantId,
        });
        const elevenResolved = (0, voice_config_resolution_util_1.resolveElevenLabsKeyChain)({
            agentSecretPlain: agentElevenPlain,
            tenantEnc: tiElevenEnc,
            decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
            envPlain: process.env.ELEVENLABS_API_KEY,
            encryptionAvailable: encAvail,
        });
        const openaiApiKey = openaiResolved.value;
        const elevenlabsApiKey = elevenResolved.value;
        const connDomain = store?.shopifyConnection?.shopDomain?.trim() || null;
        const agentUrlDomain = (0, types_1.normalizeShopifyDomain)(session.agent.shopifyStoreUrl);
        const shopDomain = connDomain || agentUrlDomain;
        const configUpdatedAt = session.agent.updatedAt?.toISOString() ?? null;
        const voiceIdEffective = session.agent.voiceId ?? workspaceElevenlabsDefaultVoiceId;
        this.log.log(JSON.stringify({
            event: 'voice.session_context.loaded_fresh',
            message: 'Loaded fresh agent config for call',
            callSessionId: session.id,
            agentId: session.agentId,
            tenantId: session.tenantId,
            model: session.agent.model ?? null,
            voiceProvider: session.agent.voiceProvider ?? null,
            voiceIdPresent: Boolean(voiceIdEffective?.trim()),
            openaiKeySource,
            elevenLabsKeySource: elevenResolved.source,
            openaiKeyPresent: Boolean(openaiApiKey?.trim()),
            elevenLabsKeyPresent: Boolean(elevenlabsApiKey?.trim()),
            configUpdatedAt,
            fieldsUpdated: null,
            precedenceNote: openaiKeySource === 'agent' && tiOpenaiEnc
                ? 'active_openai_from_agent_secrets_tenant_key_present_but_not_used'
                : null,
        }));
        return {
            callSessionId: session.id,
            tenantId: session.tenantId,
            storeId: session.storeId,
            agentId: session.agentId,
            phoneNumberId: session.phoneNumberId,
            fromNumber: session.fromNumber,
            toNumber: session.toNumber,
            configUpdatedAt,
            agent: {
                name: session.agent.name,
                voice: session.agent.voice,
                voiceProvider: session.agent.voiceProvider,
                voiceId: session.agent.voiceId ?? workspaceElevenlabsDefaultVoiceId,
                voiceStyle: session.agent.voiceStyle,
                language: session.agent.language,
                baseSystemPrompt: session.agent.baseSystemPrompt,
                agentGoal: session.agent.agentGoal ?? null,
                agentRole: session.agent.agentRole ?? null,
                toneOfVoice: session.agent.toneOfVoice ?? null,
                allowedActions: session.agent.allowedActions ?? null,
                restrictedActions: session.agent.restrictedActions ?? null,
                escalationInstructions: session.agent.escalationInstructions ?? null,
                returnRefundBehavior: session.agent.returnRefundBehavior ?? null,
                orderStatusHandling: session.agent.orderStatusHandling ?? null,
                outOfStockHandling: session.agent.outOfStockHandling ?? null,
                transferToHumanEnabled: session.agent.transferToHumanEnabled ?? true,
                escalationPhone: session.agent.escalationPhone ?? null,
                escalationEmail: session.agent.escalationEmail ?? null,
                greetingMessage: session.agent.greetingMessage,
                fallbackMessage: session.agent.fallbackMessage,
                escalationMessage: session.agent.escalationMessage,
                model: session.agent.model,
                temperature: session.agent.temperature,
                enabledTools: Array.isArray(session.agent.enabledTools) ? session.agent.enabledTools : null,
                toolPermissions: session.agent.toolPermissions && typeof session.agent.toolPermissions === 'object'
                    ? session.agent.toolPermissions
                    : null,
                personality: session.agent.voiceProfile?.providerConfig
                    ?.personality ?? null,
                maxToolCallsPerTurn: session.agent.maxToolCallsPerTurn ?? null,
                handoffEnabled: session.agent.handoffEnabled ?? null,
                knowledgeBaseSource: session.agent.knowledgeBaseSource ?? null,
                knowledgeSyncEnabled: session.agent.knowledgeSyncEnabled ?? null,
                callRoutingMode: session.agent.callRoutingMode ?? null,
                incomingCallHandling: session.agent.incomingCallHandling ?? null,
                openaiApiKey,
                elevenlabsApiKey,
                elevenlabsModel: session.agent.voiceProfile?.providerConfig?.elevenlabsModel ??
                    workspaceElevenlabsDefaultModel ??
                    null,
                languageMode: session.agent.voiceProfile?.providerConfig?.languageMode ??
                    'auto',
                fixedLanguage: session.agent.voiceProfile?.providerConfig?.fixedLanguage ??
                    null,
                supportedLanguages: session.agent.voiceProfile?.providerConfig?.supportedLanguages ??
                    ['en', 'ur', 'hi', 'ar', 'es', 'fr', 'de'],
                config: session.agent.agentConfig
                    ? {
                        businessName: session.agent.agentConfig.businessName,
                        supportEmail: session.agent.agentConfig.supportEmail,
                        supportPhone: session.agent.agentConfig.supportPhone,
                        shippingPolicy: session.agent.agentConfig.shippingPolicy,
                        returnPolicy: session.agent.agentConfig.returnPolicy,
                        exchangePolicy: session.agent.agentConfig.exchangePolicy,
                        deliveryNotes: session.agent.agentConfig.deliveryNotes,
                        escalationRules: session.agent.agentConfig.escalationRules,
                        forbiddenBehaviors: session.agent.agentConfig.forbiddenBehaviors,
                        checkoutMode: session.agent.agentConfig.checkoutMode,
                        askEmailBeforePaymentLink: session.agent.agentConfig.askEmailBeforePaymentLink,
                        fallbackHumanContact: session.agent.agentConfig.fallbackHumanContact,
                        customSystemPrompt: session.agent.agentConfig.customSystemPrompt,
                        humanHandoffRules: session.agent.agentConfig.humanHandoffRules,
                    }
                    : null,
                shopify: {
                    storeUrl: session.agent.shopifyStoreUrl ?? null,
                    shopDomain,
                    shopifyConnectionId: store?.shopifyConnection?.id ?? null,
                    hasAdminToken: Boolean(shopifyAdminToken?.trim()),
                    connectionStatus: session.agent.shopifyConnectionStatus ?? null,
                },
                runtimeCredentialHints: {
                    openaiKeySource,
                    elevenLabsKeySource: elevenResolved.source,
                },
            },
            store: {
                name: storeName,
                city: storeCity,
                timezone: storeTimezone,
            },
            metadata: session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
                ? session.metadata
                : {},
        };
    }
};
exports.SessionContextService = SessionContextService;
exports.SessionContextService = SessionContextService = SessionContextService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, encryption_service_1.EncryptionService])
], SessionContextService);
//# sourceMappingURL=session-context.service.js.map