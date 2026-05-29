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
const provider_env_slice_util_1 = require("../../../common/provider-env-slice.util");
const credential_resolver_util_1 = require("../../../common/credential-resolver.util");
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
        let agentSecrets = {};
        const cfg = session.agent.agentConfig;
        const useWorkspaceShopify = cfg?.useWorkspaceShopify === true;
        const useWorkspaceOpenai = cfg?.useWorkspaceOpenai === true;
        const useWorkspaceElevenlabs = cfg?.useWorkspaceElevenlabs === true;
        const useWorkspaceEmail = cfg?.useWorkspaceEmail === true;
        const shopifyApiVersion = cfg?.shopifyApiVersion ?? null;
        let workspace = null;
        let workspaceElevenlabsDefaultVoiceId = null;
        let workspaceElevenlabsDefaultModel = null;
        if (session.agent.secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(session.agent.secretsEnc);
            if (dec) {
                try {
                    const secrets = JSON.parse(dec);
                    agentSecrets = secrets;
                }
                catch {
                }
            }
        }
        if (this.encryption.isAvailable()) {
            const ti = await this.prisma.tenantIntegration.findUnique({
                where: { tenantId: session.tenantId },
                select: {
                    openaiApiKeyEnc: true,
                    elevenlabsApiKeyEnc: true,
                    elevenlabsDefaultModel: true,
                    elevenlabsDefaultVoiceId: true,
                    shopifyShopDomain: true,
                    shopifyAdminTokenEnc: true,
                },
            });
            workspaceElevenlabsDefaultVoiceId = ti?.elevenlabsDefaultVoiceId?.trim() || null;
            workspaceElevenlabsDefaultModel = ti?.elevenlabsDefaultModel?.trim() || null;
            if (ti) {
                const host = ti.shopifyShopDomain?.trim();
                workspace = {
                    shopifyStoreUrl: host ? (host.startsWith('http') ? host : `https://${host}`) : undefined,
                    shopifyAdminToken: ti.shopifyAdminTokenEnc
                        ? (this.encryption.decryptFromStorage(ti.shopifyAdminTokenEnc) ?? undefined)
                        : undefined,
                    openaiApiKey: ti.openaiApiKeyEnc
                        ? (this.encryption.decryptFromStorage(ti.openaiApiKeyEnc) ?? undefined)
                        : undefined,
                    elevenlabsApiKey: ti.elevenlabsApiKeyEnc
                        ? (this.encryption.decryptFromStorage(ti.elevenlabsApiKeyEnc) ?? undefined)
                        : undefined,
                    elevenlabsDefaultVoiceId: workspaceElevenlabsDefaultVoiceId ?? undefined,
                    elevenlabsDefaultModel: workspaceElevenlabsDefaultModel ?? undefined,
                };
            }
        }
        const envSlice = (0, provider_env_slice_util_1.buildProviderEnvSlice)();
        const shopifyResolved = (0, credential_resolver_util_1.resolveShopifyConfig)({
            agent: {
                shopifyStoreUrl: session.agent.shopifyStoreUrl,
                secrets: agentSecrets,
                useWorkspaceShopify,
                shopifyApiVersion,
            },
            workspace,
            env: envSlice,
        });
        const shopifyAdminToken = shopifyResolved?.shopifyAdminToken ?? null;
        const credentialSources = (0, credential_resolver_util_1.buildCredentialSourcesSummary)({
            agent: {
                shopifyStoreUrl: session.agent.shopifyStoreUrl,
                secrets: agentSecrets,
                useWorkspaceShopify,
                useWorkspaceEmail,
                useWorkspaceOpenai,
                useWorkspaceElevenlabs,
                voiceId: session.agent.voiceId,
            },
            workspace: workspace ?? undefined,
            env: envSlice,
        });
        const openaiResolved = (0, credential_resolver_util_1.resolveOpenAiConfig)({
            agentSecrets,
            workspace,
            useWorkspaceOpenai,
            envApiKey: envSlice?.openaiApiKey,
        });
        const openaiKeySource = openaiResolved?.source === 'workspace'
            ? 'tenant'
            : openaiResolved?.source === 'env'
                ? 'env'
                : openaiResolved?.source === 'agent'
                    ? 'agent'
                    : 'none';
        const elevenResolved = (0, credential_resolver_util_1.resolveElevenLabsConfig)({
            agentSecrets,
            workspace,
            useWorkspaceElevenlabs,
            envApiKey: envSlice?.elevenlabsApiKey,
            agentVoiceId: session.agent.voiceId,
        });
        const elevenLabsKeySource = elevenResolved?.source === 'workspace'
            ? 'tenant'
            : elevenResolved?.source === 'env'
                ? 'env'
                : elevenResolved?.source === 'agent'
                    ? 'agent'
                    : 'none';
        const openaiApiKey = openaiResolved?.apiKey ?? null;
        const elevenlabsApiKey = elevenResolved?.apiKey ?? null;
        const shopDomain = (0, types_1.normalizeShopifyDomain)(shopifyResolved?.shopifyStoreUrl ?? session.agent.shopifyStoreUrl) ||
            (0, types_1.normalizeShopifyDomain)(store?.shopifyConnection?.shopDomain ? `https://${store.shopifyConnection.shopDomain}` : null);
        const configUpdatedAt = session.agent.updatedAt?.toISOString() ?? null;
        const cfgMeta = session.agent.agentConfig?.metadata &&
            typeof session.agent.agentConfig.metadata === 'object' &&
            !Array.isArray(session.agent.agentConfig.metadata)
            ? session.agent.agentConfig.metadata
            : null;
        const configVersion = typeof cfgMeta?.configVersion === 'number' && Number.isFinite(cfgMeta.configVersion)
            ? Number(cfgMeta.configVersion)
            : 1;
        const promptUpdatedAt = typeof cfgMeta?.promptUpdatedAt === 'string' && cfgMeta.promptUpdatedAt.trim()
            ? cfgMeta.promptUpdatedAt
            : session.agent.agentConfig?.updatedAt?.toISOString() ?? configUpdatedAt;
        const voiceIdEffective = session.agent.voiceId?.trim() || null;
        const personality = session.agent.voiceProfile?.providerConfig
            ?.personality ?? null;
        const voiceEnergy = personality && typeof personality.voiceEnergy === 'number' ? personality.voiceEnergy : null;
        const speakingSpeed = personality && typeof personality.speakingSpeed === 'number' ? personality.speakingSpeed : null;
        const politeness = personality && typeof personality.politeness === 'number' ? personality.politeness : null;
        const upsellLevel = personality && typeof personality.upsellAggressiveness === 'number'
            ? personality.upsellAggressiveness
            : null;
        const humorLevel = personality && typeof personality.humorLevel === 'number' ? personality.humorLevel : null;
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
            elevenLabsKeySource,
            openaiKeyPresent: Boolean(openaiApiKey?.trim()),
            elevenLabsKeyPresent: Boolean(elevenlabsApiKey?.trim()),
            configUpdatedAt,
            configVersion,
            promptUpdatedAt,
            voiceId: voiceIdEffective ?? null,
            voiceEnergy,
            speakingSpeed,
            politeness,
            upsellLevel,
            humorLevel,
            source: 'database/runtime_config',
            fieldsUpdated: null,
            precedenceNote: openaiKeySource === 'agent' && workspace?.openaiApiKey
                ? 'active_openai_from_agent_secrets_workspace_key_present_but_not_used'
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
            configVersion,
            promptUpdatedAt,
            agent: {
                name: session.agent.name,
                voice: session.agent.voice,
                voiceProvider: session.agent.voiceProvider,
                voiceId: session.agent.voiceId?.trim() || null,
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
                    elevenLabsKeySource,
                    shopifySource: credentialSources.shopify.source,
                    shopifyConfigured: credentialSources.shopify.configured,
                    resendSource: credentialSources.resend.source,
                    twilioSource: credentialSources.twilio.authSource,
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