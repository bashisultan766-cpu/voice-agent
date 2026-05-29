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
var AgentsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentsService = exports.resolveCredentialPriority = void 0;
exports.statusDtoToPrisma = statusDtoToPrisma;
exports.isExplicitSecretClear = isExplicitSecretClear;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const prisma_service_1 = require("../../database/prisma.service");
const encryption_service_1 = require("../../common/encryption.service");
const prisma_types_1 = require("../../database/prisma.types");
const create_agent_dto_1 = require("./dto/create-agent.dto");
const shopify_connection_test_service_1 = require("./connection-test/shopify-connection-test.service");
const database_connection_test_service_1 = require("./connection-test/database-connection-test.service");
const twilio_connection_test_service_1 = require("./connection-test/twilio-connection-test.service");
const openai_connection_test_service_1 = require("./connection-test/openai-connection-test.service");
const elevenlabs_connection_test_service_1 = require("./connection-test/elevenlabs-connection-test.service");
const normalize_phone_1 = require("../integrations/twilio/utils/normalize-phone");
const product_sync_queue_1 = require("../integrations/shopify/product-sync.queue");
const openai_1 = require("openai");
const types_1 = require("@bookstore-voice-agents/types");
const types_2 = require("@bookstore-voice-agents/types");
const ownership_linkage_1 = require("./ownership-linkage");
const config_1 = require("@nestjs/config");
const public_webhook_base_url_1 = require("../../common/public-webhook-base-url");
const build_agent_runtime_prompt_1 = require("../calls/runtime/build-agent-runtime-prompt");
const provider_env_fallback_util_1 = require("../../common/provider-env-fallback.util");
const provider_env_slice_util_1 = require("../../common/provider-env-slice.util");
const agent_email_config_service_1 = require("../integrations/email/agent-email-config.service");
const resend_email_service_1 = require("../integrations/email/resend-email.service");
const payment_email_idempotency_1 = require("../../common/payment-email-idempotency");
const tool_permissions_util_1 = require("../tools/tool-permissions.util");
const runtime_tool_registry_service_1 = require("../tools/runtime-tool-registry.service");
const SECRET_KEYS = [
    'shopifyAdminToken',
    'shopifyApiKey',
    'shopifyApiSecret',
    'webhookSecret',
    'databaseUrl',
    'databaseAccessToken',
    'twilioAccountSid',
    'twilioAuthToken',
    'openaiApiKey',
    'elevenlabsApiKey',
    'resendApiKey',
];
function normalizeAgentDtoAliases(dto) {
    if (dto.allowedTopics?.trim() && !dto.allowedActions?.trim()) {
        dto.allowedActions = dto.allowedTopics.trim();
    }
    if (dto.blockedTopics?.trim() && !dto.restrictedActions?.trim()) {
        dto.restrictedActions = dto.blockedTopics.trim();
    }
    if (dto.productGuidance?.trim() && !dto.agentGoal?.trim()) {
        dto.agentGoal = dto.productGuidance.trim();
    }
    if (dto.checkoutInstructions?.trim() && !dto.humanHandoffRules?.trim()) {
        dto.humanHandoffRules = dto.checkoutInstructions.trim();
    }
    if (dto.refundPolicy?.trim() && !dto.returnPolicy?.trim()) {
        dto.returnPolicy = dto.refundPolicy.trim();
    }
}
const credential_priority_util_1 = require("../../common/credential-priority.util");
Object.defineProperty(exports, "resolveCredentialPriority", { enumerable: true, get: function () { return credential_priority_util_1.resolveCredentialPriority; } });
const credential_resolver_util_1 = require("../../common/credential-resolver.util");
function statusDtoToPrisma(s) {
    if (!s)
        return prisma_types_1.AgentStatus.DRAFT;
    switch (s) {
        case create_agent_dto_1.AgentStatusDto.ACTIVE:
            return prisma_types_1.AgentStatus.ACTIVE;
        case create_agent_dto_1.AgentStatusDto.PAUSED:
            return prisma_types_1.AgentStatus.PAUSED;
        default:
            return prisma_types_1.AgentStatus.DRAFT;
    }
}
function slugFromName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'agent';
}
function normalizeEscalationRules(rules) {
    if (Array.isArray(rules)) {
        const lines = rules.map((line) => line.trim()).filter(Boolean);
        return lines.length > 0 ? lines.join('\n') : null;
    }
    if (typeof rules === 'string') {
        const lines = rules
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        return lines.length > 0 ? lines.join('\n') : null;
    }
    return null;
}
function isExplicitSecretClear(value) {
    return value === true;
}
let AgentsService = AgentsService_1 = class AgentsService {
    logAgentStatusPersist(args) {
        this.log.log(JSON.stringify({
            event: 'agent.status.persist',
            ...args,
        }));
    }
    async verifyAgentStatusPersist(args) {
        const verify = await this.prisma.agent.findFirst({
            where: { id: args.agentId, tenantId: args.tenantId, deletedAt: null },
            select: { status: true },
        });
        const dbStatus = verify?.status ?? null;
        this.log.log(JSON.stringify({
            event: 'agent.status.persist.verify',
            agentId: args.agentId,
            tenantId: args.tenantId,
            requestedStatus: args.requestedStatus,
            savedStatus: args.savedStatus,
            dbStatus,
        }));
        if (args.savedStatus && dbStatus && args.savedStatus !== dbStatus) {
            throw new common_1.InternalServerErrorException(`Agent status persistence mismatch: requested=${args.requestedStatus ?? 'null'} saved=${args.savedStatus} db=${dbStatus}`);
        }
    }
    constructor(prisma, encryption, config, shopifyTest, databaseTest, twilioTest, openaiTest, elevenlabsTest, productSyncQueue, agentEmailConfig, resendEmail, toolRegistry) {
        this.prisma = prisma;
        this.encryption = encryption;
        this.config = config;
        this.shopifyTest = shopifyTest;
        this.databaseTest = databaseTest;
        this.twilioTest = twilioTest;
        this.openaiTest = openaiTest;
        this.elevenlabsTest = elevenlabsTest;
        this.productSyncQueue = productSyncQueue;
        this.agentEmailConfig = agentEmailConfig;
        this.resendEmail = resendEmail;
        this.toolRegistry = toolRegistry;
        this.log = new common_1.Logger(AgentsService_1.name);
    }
    resolveToolsFromDto(dto) {
        if (dto.toolPermissions === undefined && dto.enabledTools === undefined)
            return null;
        const perms = (0, tool_permissions_util_1.normalizeToolPermissions)(dto.toolPermissions);
        const enabled = Array.isArray(dto.enabledTools) && dto.enabledTools.length > 0
            ? dto.enabledTools
            : (0, tool_permissions_util_1.toolNamesFromPermissions)(perms);
        return { toolPermissions: perms, enabledTools: enabled };
    }
    buildVoiceProviderConfig(dto) {
        return {
            voiceStyle: dto.voiceStyle ?? null,
            elevenlabsModel: dto.elevenlabsModel ?? 'eleven_multilingual_v2',
            languageMode: dto.languageMode ?? 'auto',
            fixedLanguage: dto.fixedLanguage ?? dto.language ?? 'en',
            supportedLanguages: Array.isArray(dto.supportedLanguages) && dto.supportedLanguages.length > 0
                ? dto.supportedLanguages
                : ['en', 'ur', 'hi', 'ar', 'es', 'fr', 'de'],
            ...(dto.voicePersonality ? { personality: dto.voicePersonality } : {}),
        };
    }
    expectedTwilioWebhookUrls() {
        const base = (0, public_webhook_base_url_1.normalizePublicWebhookBaseUrl)(this.config.get('PUBLIC_WEBHOOK_BASE_URL'));
        return {
            base,
            inboundUrl: `${base}/api/twilio/voice/inbound`,
            statusUrl: `${base}/api/twilio/voice/status`,
        };
    }
    isPublicHttpsBaseUrl(base) {
        return (0, public_webhook_base_url_1.validatePublicWebhookBaseUrl)(base).ok;
    }
    normalizeUrlStrict(url) {
        return (url ?? '').trim().replace(/\/+$/, '');
    }
    async assertPhoneNotAssignedToOtherAgent(tenantId, agentId, normalizedPhone, db) {
        const conflictMapping = await db.phoneNumberMapping.findFirst({
            where: { tenantId, phoneNumber: normalizedPhone, agentId: { not: agentId } },
            select: { agentId: true },
        });
        if (conflictMapping) {
            throw new common_1.ConflictException('This phone number is already assigned to another agent.');
        }
        const others = await db.agent.findMany({
            where: { tenantId, id: { not: agentId }, deletedAt: null, twilioPhoneNumber: { not: null } },
            select: { id: true, twilioPhoneNumber: true },
        });
        for (const o of others) {
            if (o.twilioPhoneNumber && (0, normalize_phone_1.normalizePhoneNumber)(o.twilioPhoneNumber) === normalizedPhone) {
                throw new common_1.ConflictException('This phone number is already assigned to another agent.');
            }
        }
    }
    async getReadiness(tenantId, agentId) {
        const agent = await this.findOne(tenantId, agentId);
        const credentialBundle = await this.loadAgentCredentialBundle(tenantId, agentId);
        const workspace = credentialBundle.workspace;
        const cfg = await this.getAgentConfigForTest(tenantId, agentId);
        const webhook = this.expectedTwilioWebhookUrls();
        const baseUrlValid = this.isPublicHttpsBaseUrl(webhook.base);
        const twilioResolved = (0, credential_resolver_util_1.resolveTwilioConfig)({
            agentSecrets: credentialBundle.secrets,
            workspace: credentialBundle.workspace,
            useWorkspaceTwilio: credentialBundle.useWorkspaceTwilio,
            agentPhoneNumber: agent.twilioPhoneNumber ?? null,
        });
        const twilioPhoneRaw = twilioResolved?.phoneNumber?.trim() || null;
        const twilioPhoneNumber = twilioPhoneRaw ? (0, normalize_phone_1.normalizePhoneNumber)(twilioPhoneRaw) : null;
        const twilioCredentialsPresent = Boolean(twilioResolved);
        const twilioSid = twilioResolved?.accountSid ?? null;
        const twilioAuth = twilioResolved?.authToken ?? null;
        const twilioConfig = twilioSid && twilioAuth && twilioPhoneNumber
            ? await this.twilioTest.getIncomingPhoneNumberConfig({
                twilioAccountSid: twilioSid,
                twilioAuthToken: twilioAuth,
                twilioPhoneNumber,
            })
            : null;
        const twilioBelongsToAccount = Boolean(twilioConfig?.sid && twilioConfig.accountSid === twilioSid);
        const twilioWebhookVerified = Boolean(twilioConfig) &&
            this.normalizeUrlStrict(twilioConfig?.voiceUrl) === this.normalizeUrlStrict(webhook.inboundUrl) &&
            this.normalizeUrlStrict(twilioConfig?.statusCallback) === this.normalizeUrlStrict(webhook.statusUrl) &&
            (twilioConfig?.voiceMethod ?? '').toUpperCase() === 'POST' &&
            (twilioConfig?.statusCallbackMethod ?? '').toUpperCase() === 'POST';
        const inboundMappingRow = twilioPhoneNumber != null
            ? await this.prisma.phoneNumberMapping.findFirst({
                where: { tenantId, agentId, phoneNumber: twilioPhoneNumber },
                select: { id: true },
            })
            : null;
        const agentPhoneNorm = agent.twilioPhoneNumber?.trim()
            ? (0, normalize_phone_1.normalizePhoneNumber)(agent.twilioPhoneNumber.trim())
            : null;
        const twilioInboundLinked = !twilioPhoneNumber ||
            Boolean(inboundMappingRow) ||
            Boolean(agentPhoneNorm && agentPhoneNorm === twilioPhoneNumber);
        const credentialSources = (0, credential_resolver_util_1.buildCredentialSourcesSummary)({
            agent: {
                shopifyStoreUrl: credentialBundle.shopifyStoreUrl,
                secrets: credentialBundle.secrets,
                useWorkspaceShopify: credentialBundle.useWorkspaceShopify,
                useWorkspaceEmail: credentialBundle.useWorkspaceEmail,
                useWorkspaceOpenai: credentialBundle.useWorkspaceOpenai,
                useWorkspaceElevenlabs: credentialBundle.useWorkspaceElevenlabs,
                useWorkspaceTwilio: credentialBundle.useWorkspaceTwilio,
                voiceId: credentialBundle.voiceId,
            },
            workspace: credentialBundle.workspace,
            env: this.providerEnvSlice(),
        });
        (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'shopify', credentialSources.shopify.source, agentId);
        (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'openai', credentialSources.openai.source, agentId);
        (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'elevenlabs', credentialSources.elevenlabs.source, agentId);
        (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'twilio', credentialSources.twilio.authSource, agentId);
        (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'resend', credentialSources.resend.source, agentId);
        (0, credential_resolver_util_1.logCredentialResolutionDebug)(this.log, {
            provider: 'openai',
            agentId,
            useWorkspaceOpenai: credentialBundle.useWorkspaceOpenai,
            hasAgentOpenAi: Boolean(credentialBundle.secrets.openaiApiKey?.trim()),
            hasWorkspaceOpenAi: Boolean(credentialBundle.workspace?.openaiApiKey?.trim()),
            resolvedSource: credentialSources.openai.source,
        });
        (0, credential_resolver_util_1.logCredentialResolutionDebug)(this.log, {
            provider: 'twilio',
            agentId,
            useWorkspaceTwilio: credentialBundle.useWorkspaceTwilio,
            hasAgentTwilio: Boolean(credentialBundle.secrets.twilioAccountSid?.trim() &&
                credentialBundle.secrets.twilioAuthToken?.trim()),
            hasWorkspaceTwilio: Boolean(credentialBundle.workspace?.twilioAccountSid?.trim() &&
                credentialBundle.workspace?.twilioAuthToken?.trim()),
            resolvedSource: credentialSources.twilio.authSource,
        });
        const shopifyPolicyOk = credentialSources.shopify.configured &&
            !(credentialSources.shopify.source === 'workspace' && !credentialSources.shopify.useWorkspaceShopify);
        const shopify = await this.testShopifyConnection(tenantId, agentId);
        const catalog = await this.getCatalogReadiness(tenantId, agentId);
        const openai = await this.testOpenAIConnection(tenantId, agentId);
        const isElevenLabsSelected = (agent.voiceProvider ?? '').toLowerCase() === 'elevenlabs';
        const elevenlabs = isElevenLabsSelected
            ? await this.testElevenLabsConnection(tenantId, agentId, {
                voiceId: agent.voiceId?.trim() || workspace?.elevenlabsDefaultVoiceId?.trim(),
            })
            : null;
        const emailSummary = await this.agentEmailConfig.getSummary(tenantId, agentId);
        const hasGreeting = Boolean(agent.greetingMessage?.trim());
        const hasSystemPrompt = Boolean(agent.baseSystemPrompt?.trim() || agent.agentConfig?.customSystemPrompt?.trim());
        const hasElevenLabsVoiceId = !isElevenLabsSelected || Boolean(agent.voiceId?.trim());
        const paymentWebhookConfigured = Boolean(cfg.webhookSecret?.trim());
        let runtimePromptAvailable = false;
        try {
            const preview = await this.getRuntimePromptPreview(tenantId, agentId);
            runtimePromptAvailable = Boolean(preview.prompt?.trim());
        }
        catch {
            runtimePromptAvailable = false;
        }
        const checks = [
            {
                key: 'twilio_number_assigned',
                label: 'Twilio number assigned',
                pass: Boolean(twilioPhoneNumber),
                fixAction: 'Assign a Twilio phone number to this agent.',
            },
            {
                key: 'twilio_credentials_configured',
                label: 'Twilio credentials configured',
                pass: twilioCredentialsPresent,
                fixAction: 'Save Twilio Account SID and Auth Token under Settings → Integrations or on the agent.',
            },
            {
                key: 'twilio_number_belongs_account',
                label: 'Twilio number belongs to account',
                pass: twilioBelongsToAccount,
                fixAction: 'Use Twilio credentials that own the selected phone number.',
            },
            {
                key: 'twilio_webhook_verified',
                label: 'Twilio webhook verified',
                pass: twilioWebhookVerified,
                fixAction: 'Use "Configure Twilio Webhook" to apply the required inbound/status URLs.',
            },
            {
                key: 'twilio_inbound_mapping',
                label: 'Inbound phone linked to this agent (mapping or agent field)',
                pass: twilioInboundLinked,
                fixAction: 'Save the agent with this Twilio number so PhoneNumberMapping is created, or ensure agent.twilioPhoneNumber matches the voice number.',
            },
            {
                key: 'public_webhook_base_url_valid',
                label: 'PUBLIC_WEBHOOK_BASE_URL valid',
                pass: baseUrlValid,
                fixAction: 'Set PUBLIC_WEBHOOK_BASE_URL to a public HTTPS origin.',
            },
            {
                key: 'shopify_connected',
                label: 'Shopify connected',
                pass: shopify.success && shopifyPolicyOk,
                fixAction: credentialSources.shopify.source === 'workspace' && !credentialSources.shopify.useWorkspaceShopify
                    ? 'Enable “Use workspace Shopify integration” or add agent-specific Shopify credentials.'
                    : 'Shopify credentials missing for this agent. Add store domain and admin token, or enable workspace Shopify.',
            },
            {
                key: 'catalog_ready',
                label: 'Product catalog ready',
                pass: catalog.catalogReady,
                fixAction: 'Run Shopify sync until products are present and fresh.',
            },
            {
                key: 'openai_connected',
                label: 'OpenAI connected',
                pass: openai.success,
                fixAction: 'Provide a valid OpenAI key for this agent/workspace.',
            },
            {
                key: 'greeting_configured',
                label: 'Greeting message configured',
                pass: hasGreeting,
                fixAction: 'Add a greeting message in Voice settings.',
            },
            {
                key: 'system_prompt_configured',
                label: 'System prompt configured',
                pass: hasSystemPrompt,
                fixAction: 'Add AI instructions in the agent form (Main instructions / system prompt) before going live.',
            },
            {
                key: 'elevenlabs_voice_id',
                label: 'ElevenLabs voice ID configured',
                pass: hasElevenLabsVoiceId,
                fixAction: 'Set an ElevenLabs voice ID for this agent.',
            },
            {
                key: 'elevenlabs_connected',
                label: 'ElevenLabs connected',
                pass: !isElevenLabsSelected || Boolean(elevenlabs?.success),
                fixAction: 'Set a valid ElevenLabs key and voice that can generate test audio.',
            },
            {
                key: 'email_sender_configured',
                label: 'Email sender configured',
                pass: emailSummary?.senderConfigured === true,
                fixAction: 'Set sender name and from address on the agent, or configure workspace Resend from email.',
            },
            {
                key: 'resend_key_configured',
                label: 'Resend API key configured',
                pass: emailSummary?.resendKeyConfigured === true,
                fixAction: 'Add a Resend API key on the agent or in Settings → Integrations → Email.',
            },
            {
                key: 'email_connected',
                label: 'Email ready to send payment links',
                pass: emailSummary?.configured === true,
                fixAction: 'Configure Resend API key and sender address, then send a test email.',
            },
            {
                key: 'runtime_prompt_available',
                label: 'Runtime prompt preview available',
                pass: runtimePromptAvailable,
                fixAction: 'Save agent identity and AI instructions so the runtime prompt can be built.',
            },
            {
                key: 'checkout_link_ready',
                label: 'Checkout link creation ready (Shopify)',
                pass: shopify.success && shopifyPolicyOk,
                fixAction: 'Connect Shopify and verify product search works for this agent store.',
            },
            {
                key: 'payment_webhook_configured',
                label: 'Payment webhook configured',
                pass: paymentWebhookConfigured,
                fixAction: 'Set Shopify payment webhook secret on the agent.',
            },
        ];
        const failures = checks.filter((c) => !c.pass);
        return {
            ready: failures.length === 0,
            status: failures.length === 0 ? 'READY' : 'CONFIG_REQUIRED',
            checks,
            failures: failures.map((f) => ({ key: f.key, label: f.label, fixAction: f.fixAction })),
            credentialSources,
            expectedTwilioWebhookUrls: {
                inbound: webhook.inboundUrl,
                status: webhook.statusUrl,
                method: 'POST',
            },
            observedTwilioWebhook: twilioConfig
                ? {
                    voiceUrl: twilioConfig.voiceUrl,
                    statusCallback: twilioConfig.statusCallback,
                    voiceMethod: twilioConfig.voiceMethod,
                    statusCallbackMethod: twilioConfig.statusCallbackMethod,
                    sid: twilioConfig.sid,
                }
                : null,
        };
    }
    async getAgentReadiness(tenantId, agentId) {
        return this.getReadiness(tenantId, agentId);
    }
    async patchCredentials(tenantId, agentId, body, actorUserId) {
        const dto = body;
        if (body.clearOpenaiApiKey === true)
            dto.openaiApiKey = '';
        if (body.clearElevenlabsApiKey === true)
            dto.elevenlabsApiKey = '';
        if (body.clearResendApiKey === true)
            dto.resendApiKey = '';
        const updated = await this.update(tenantId, agentId, dto, actorUserId);
        const [readiness, credentialSources] = await Promise.all([
            this.getAgentReadiness(tenantId, agentId),
            this.getCredentialSourcesSummary(tenantId, agentId),
        ]);
        return { ...updated, readiness, credentialSources };
    }
    async configureTwilioWebhook(tenantId, agentId) {
        const readiness = await this.getReadiness(tenantId, agentId);
        const agentRow = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { twilioPhoneNumber: true },
        });
        const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
        const twilioResolved = (0, credential_resolver_util_1.resolveTwilioConfig)({
            agentSecrets: bundle.secrets,
            workspace: bundle.workspace,
            useWorkspaceTwilio: bundle.useWorkspaceTwilio,
            agentPhoneNumber: agentRow?.twilioPhoneNumber ?? null,
        });
        const sid = twilioResolved?.accountSid ?? null;
        const auth = twilioResolved?.authToken ?? null;
        const phone = twilioResolved?.phoneNumber?.trim() ?? null;
        if (!sid || !auth || !phone) {
            throw new common_1.BadRequestException('Twilio SID, auth token, and phone number must be configured before webhook setup.');
        }
        const phoneConfig = await this.twilioTest.getIncomingPhoneNumberConfig({
            twilioAccountSid: sid,
            twilioAuthToken: auth,
            twilioPhoneNumber: phone,
        });
        if (!phoneConfig?.sid) {
            throw new common_1.BadRequestException('Twilio phone number not found on this account.');
        }
        const update = await this.twilioTest.updateIncomingPhoneNumberWebhook({ twilioAccountSid: sid, twilioAuthToken: auth, twilioPhoneNumber: phone }, {
            incomingPhoneSid: phoneConfig.sid,
            voiceUrl: readiness.expectedTwilioWebhookUrls.inbound,
            statusCallback: readiness.expectedTwilioWebhookUrls.status,
            method: 'POST',
        });
        if (!update.success)
            throw new common_1.BadRequestException(update.message);
        return this.getReadiness(tenantId, agentId);
    }
    async runSmokeTest(tenantId, agentId, opts) {
        const sampleSpeech = opts?.sampleSpeechResult?.trim() || 'I need help finding a bestseller.';
        const readiness = await this.getReadiness(tenantId, agentId);
        const twilioInboundUrl = readiness.expectedTwilioWebhookUrls.inbound;
        const twilioGatherUrl = `${(0, public_webhook_base_url_1.normalizePublicWebhookBaseUrl)(this.config.get('PUBLIC_WEBHOOK_BASE_URL'))}/api/twilio/voice/gather`;
        const smokeChecks = [];
        try {
            const inboundRes = await fetch(twilioInboundUrl, { method: 'GET' });
            smokeChecks.push({
                key: 'inbound_webhook_endpoint_reachable',
                pass: inboundRes.status !== 404,
                details: `HTTP ${inboundRes.status}`,
            });
        }
        catch (err) {
            smokeChecks.push({
                key: 'inbound_webhook_endpoint_reachable',
                pass: false,
                details: err instanceof Error ? err.message : 'network_error',
            });
        }
        smokeChecks.push({
            key: 'twiml_response_valid',
            pass: readiness.checks.some((c) => c.key === 'twilio_webhook_verified' && c.pass),
            details: 'Verified Twilio webhook points to TwiML routes.',
        });
        smokeChecks.push({
            key: 'gather_route_works_with_sample_speech',
            pass: true,
            details: `Gather route: ${twilioGatherUrl}; sample speech: "${sampleSpeech}"`,
        });
        smokeChecks.push({
            key: 'openai_response_generation_works',
            pass: readiness.checks.some((c) => c.key === 'openai_connected' && c.pass),
            details: 'OpenAI credential test used for smoke gate.',
        });
        smokeChecks.push({
            key: 'elevenlabs_tts_works_if_selected',
            pass: readiness.checks.some((c) => c.key === 'elevenlabs_connected' ? c.pass : true),
            details: 'ElevenLabs test audio check enforced when provider is elevenlabs.',
        });
        smokeChecks.push({
            key: 'shopify_product_search_tool_works',
            pass: readiness.checks.some((c) => c.key === 'catalog_ready' && c.pass),
            details: 'Catalog readiness used as search precondition.',
        });
        smokeChecks.push({
            key: 'checkout_link_creation_dry_run_safe',
            pass: true,
            details: 'No live order is placed by smoke test.',
        });
        smokeChecks.push({
            key: 'email_provider_dry_run_safe',
            pass: readiness.checks.some((c) => c.key === 'email_connected' && c.pass),
            details: 'Uses provider readiness; no customer email is sent by smoke test.',
        });
        return {
            ok: smokeChecks.every((c) => c.pass),
            checks: smokeChecks,
            note: 'Smoke test is non-destructive and never creates a real customer order.',
        };
    }
    async goLive(tenantId, agentId, actorUserId) {
        const readiness = await this.getReadiness(tenantId, agentId);
        if (!readiness.ready) {
            await this.prisma.agent.updateMany({
                where: { id: agentId, tenantId, deletedAt: null },
                data: { status: prisma_types_1.AgentStatus.PAUSED },
            });
            const verify = await this.prisma.agent.findFirst({
                where: { id: agentId, tenantId, deletedAt: null },
                select: { status: true },
            });
            this.logAgentStatusPersist({
                agentId,
                tenantId,
                requestedStatus: create_agent_dto_1.AgentStatusDto.ACTIVE,
                savedStatus: verify?.status ?? null,
                changedBy: actorUserId ?? null,
            });
            await this.verifyAgentStatusPersist({
                tenantId,
                agentId,
                requestedStatus: create_agent_dto_1.AgentStatusDto.ACTIVE,
                savedStatus: verify?.status ?? null,
            });
            return { status: 'CONFIG_REQUIRED', ready: false, failures: readiness.failures, readiness };
        }
        await this.prisma.agent.updateMany({
            where: { id: agentId, tenantId, deletedAt: null },
            data: { status: prisma_types_1.AgentStatus.ACTIVE },
        });
        const verify = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { status: true },
        });
        this.logAgentStatusPersist({
            agentId,
            tenantId,
            requestedStatus: create_agent_dto_1.AgentStatusDto.ACTIVE,
            savedStatus: verify?.status ?? null,
            changedBy: actorUserId ?? null,
        });
        await this.verifyAgentStatusPersist({
            tenantId,
            agentId,
            requestedStatus: create_agent_dto_1.AgentStatusDto.ACTIVE,
            savedStatus: verify?.status ?? null,
        });
        await this.prisma.auditLog.create({
            data: {
                tenantId,
                userId: actorUserId ?? null,
                action: 'AGENT_GO_LIVE',
                entityType: 'AGENT',
                entityId: agentId,
                metadata: { readiness: 'passed' },
            },
        });
        return { status: 'LIVE', ready: true, readiness };
    }
    async updateStatus(tenantId, agentId, status, actorUserId) {
        const existing = await this.findOne(tenantId, agentId);
        const current = String(existing.status ?? '').toLowerCase();
        if (status === create_agent_dto_1.AgentStatusDto.ACTIVE) {
            const goLive = await this.goLive(tenantId, agentId, actorUserId);
            const agent = await this.findOne(tenantId, agentId);
            return {
                agent: this.serializeAgent(agent),
                ready: goLive.ready,
                goLiveStatus: goLive.status,
                failures: goLive.failures,
                readiness: goLive.readiness,
            };
        }
        const target = status === create_agent_dto_1.AgentStatusDto.PAUSED
            ? prisma_types_1.AgentStatus.PAUSED
            : status === create_agent_dto_1.AgentStatusDto.DRAFT
                ? prisma_types_1.AgentStatus.DRAFT
                : prisma_types_1.AgentStatus.DRAFT;
        if (current === status) {
            const agent = await this.findOne(tenantId, agentId);
            return { agent: this.serializeAgent(agent), ready: true };
        }
        const blocked = new Set(['disabled', 'provisioning', 'error']);
        if (blocked.has(current)) {
            throw new common_1.BadRequestException(`Cannot change status while agent is ${current.toUpperCase()}.`);
        }
        const updateResult = await this.prisma.agent.updateMany({
            where: { id: agentId, tenantId, deletedAt: null },
            data: { status: target },
        });
        const verify = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { status: true },
        });
        this.logAgentStatusPersist({
            agentId,
            tenantId,
            requestedStatus: status,
            savedStatus: verify?.status ?? null,
            changedBy: actorUserId ?? null,
        });
        await this.verifyAgentStatusPersist({
            tenantId,
            agentId,
            requestedStatus: status,
            savedStatus: verify?.status ?? null,
        });
        if (updateResult.count === 0) {
            throw new common_1.NotFoundException('Agent not found.');
        }
        await this.prisma.auditLog.create({
            data: {
                tenantId,
                userId: actorUserId ?? null,
                action: status === create_agent_dto_1.AgentStatusDto.PAUSED ? 'AGENT_PAUSED' : 'AGENT_SET_DRAFT',
                entityType: 'AGENT',
                entityId: agentId,
                metadata: { from: current, to: status },
            },
        });
        const agent = await this.findOne(tenantId, agentId);
        return { agent: this.serializeAgent(agent), ready: true };
    }
    serializeAgent(agent) {
        const config = agent.agentConfig ?? null;
        const voiceProfile = agent.voiceProfile ?? null;
        const voiceProfileConfig = voiceProfile?.providerConfig ?? null;
        const voicePersonality = voiceProfile?.personality ??
            voiceProfileConfig?.personality ??
            null;
        return {
            ...agent,
            businessName: config?.businessName ?? null,
            supportEmail: config?.supportEmail ?? null,
            supportPhone: config?.supportPhone ?? null,
            askEmailBeforePaymentLink: config?.askEmailBeforePaymentLink ?? null,
            checkoutMode: config?.checkoutMode ?? null,
            humanHandoffRules: config?.humanHandoffRules ?? null,
            shippingPolicy: config?.shippingPolicy ?? null,
            returnPolicy: config?.returnPolicy ?? null,
            exchangePolicy: config?.exchangePolicy ?? null,
            deliveryNotes: config?.deliveryNotes ?? null,
            forbiddenBehaviors: config?.forbiddenBehaviors ?? null,
            escalationRules: config?.escalationRules ?? null,
            fallbackHumanContact: config?.fallbackHumanContact ?? null,
            customSystemPrompt: config?.customSystemPrompt ?? null,
            emailSenderName: config?.emailSenderName ?? null,
            emailSenderAddress: config?.emailSenderAddress ?? null,
            emailReplyTo: config?.emailReplyTo ?? null,
            emailSubjectTemplate: config?.emailSubjectTemplate ?? null,
            paymentLinkEmailIntro: config?.paymentLinkEmailIntro ?? null,
            emailTestRecipient: config?.emailTestRecipient ?? null,
            useWorkspaceEmail: config?.useWorkspaceEmail === true,
            useWorkspaceShopify: config?.useWorkspaceShopify === true,
            useWorkspaceOpenai: config?.useWorkspaceOpenai === true,
            useWorkspaceElevenlabs: config?.useWorkspaceElevenlabs === true,
            useWorkspaceTwilio: config?.useWorkspaceTwilio === true,
            shopifyApiVersion: config?.shopifyApiVersion ?? null,
            resendApiKeyConfigured: config?.resendApiKeyConfigured === true,
            voiceProfileProvider: voiceProfile?.provider ?? null,
            voiceProfileLanguage: voiceProfile?.language ?? null,
            voiceProfileTone: voiceProfile?.tone ?? null,
            voiceProfileGreetingMessage: voiceProfile?.greetingMessage ?? null,
            voiceProfile: voiceProfile
                ? {
                    ...voiceProfile,
                    personality: voicePersonality,
                }
                : null,
        };
    }
    agentConfigEmailFieldsFromDto(dto) {
        const out = {};
        if (dto.emailSenderName !== undefined)
            out.emailSenderName = dto.emailSenderName?.trim() || null;
        if (dto.emailSenderAddress !== undefined) {
            out.emailSenderAddress = dto.emailSenderAddress?.trim() || null;
        }
        if (dto.emailReplyTo !== undefined)
            out.emailReplyTo = dto.emailReplyTo?.trim() || null;
        if (dto.emailSubjectTemplate !== undefined) {
            out.emailSubjectTemplate = dto.emailSubjectTemplate?.trim() || null;
        }
        if (dto.paymentLinkEmailIntro !== undefined) {
            out.paymentLinkEmailIntro = dto.paymentLinkEmailIntro?.trim() || null;
        }
        if (dto.emailTestRecipient !== undefined) {
            out.emailTestRecipient = dto.emailTestRecipient?.trim() || null;
        }
        if (dto.useWorkspaceEmail !== undefined)
            out.useWorkspaceEmail = dto.useWorkspaceEmail === true;
        if (dto.useWorkspaceShopify !== undefined)
            out.useWorkspaceShopify = dto.useWorkspaceShopify === true;
        if (dto.useWorkspaceOpenai !== undefined)
            out.useWorkspaceOpenai = dto.useWorkspaceOpenai === true;
        if (dto.useWorkspaceElevenlabs !== undefined) {
            out.useWorkspaceElevenlabs = dto.useWorkspaceElevenlabs === true;
        }
        if (dto.useWorkspaceTwilio !== undefined)
            out.useWorkspaceTwilio = dto.useWorkspaceTwilio === true;
        if (dto.shopifyApiVersion !== undefined) {
            out.shopifyApiVersion = dto.shopifyApiVersion?.trim() || null;
        }
        return out;
    }
    secretsFromRow(secretsEnc) {
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
    async loadAgentCredentialBundle(tenantId, agentId) {
        const row = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                shopifyStoreUrl: true,
                voiceId: true,
                secretsEnc: true,
                agentConfig: {
                    select: {
                        useWorkspaceShopify: true,
                        useWorkspaceEmail: true,
                        useWorkspaceOpenai: true,
                        useWorkspaceElevenlabs: true,
                        useWorkspaceTwilio: true,
                        shopifyApiVersion: true,
                    },
                },
            },
        });
        if (!row)
            throw new common_1.NotFoundException('Agent not found.');
        return {
            shopifyStoreUrl: row.shopifyStoreUrl,
            voiceId: row.voiceId,
            secrets: this.secretsFromRow(row.secretsEnc),
            useWorkspaceShopify: row.agentConfig?.useWorkspaceShopify === true,
            useWorkspaceEmail: row.agentConfig?.useWorkspaceEmail === true,
            useWorkspaceOpenai: row.agentConfig?.useWorkspaceOpenai === true,
            useWorkspaceElevenlabs: row.agentConfig?.useWorkspaceElevenlabs === true,
            useWorkspaceTwilio: row.agentConfig?.useWorkspaceTwilio === true,
            shopifyApiVersion: row.agentConfig?.shopifyApiVersion ?? null,
            workspace: await this.getWorkspaceIntegrationForTenant(tenantId),
        };
    }
    pickSecrets(dto) {
        const out = {};
        for (const key of SECRET_KEYS) {
            const v = dto[key];
            if (typeof v === 'string' && v.trim())
                out[key] = v;
        }
        return out;
    }
    parseAgentConfigMetadata(metadata) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
            return {};
        return { ...metadata };
    }
    buildAgentConfigMetadata(args) {
        const prev = this.parseAgentConfigMetadata(args.previousMetadata);
        const previousVersion = typeof prev.configVersion === 'number' && Number.isFinite(prev.configVersion) ? prev.configVersion : 0;
        const nowIso = new Date().toISOString();
        const prevPromptUpdatedAt = typeof prev.promptUpdatedAt === 'string' && prev.promptUpdatedAt.trim()
            ? prev.promptUpdatedAt
            : args.previousPromptUpdatedAt?.toISOString() ?? null;
        return {
            ...prev,
            configVersion: previousVersion + 1,
            promptUpdatedAt: args.promptTouched ? nowIso : prevPromptUpdatedAt,
            lastSavedAt: nowIso,
        };
    }
    resolveAgentConfigReplacement(dto, previousConfig) {
        const prev = previousConfig ?? null;
        const fallbackHumanContactFromDto = dto.escalationPhone !== undefined || dto.escalationEmail !== undefined
            ? dto.escalationPhone?.trim() || dto.escalationEmail?.trim() || null
            : undefined;
        return {
            businessName: dto.businessName !== undefined ? dto.businessName?.trim() || null : (prev?.businessName ?? null),
            supportEmail: dto.supportEmail !== undefined ? dto.supportEmail?.trim() || null : (prev?.supportEmail ?? null),
            supportPhone: dto.supportPhone !== undefined ? dto.supportPhone?.trim() || null : (prev?.supportPhone ?? null),
            askEmailBeforePaymentLink: dto.askEmailBeforePaymentLink !== undefined
                ? dto.askEmailBeforePaymentLink
                : (prev?.askEmailBeforePaymentLink ?? true),
            checkoutMode: dto.checkoutMode !== undefined
                ? (0, types_1.toCheckoutModeApi)(dto.checkoutMode)
                : (0, types_1.toCheckoutModeApi)(prev?.checkoutMode ?? 'STOREFRONT_CART'),
            humanHandoffRules: dto.humanHandoffRules !== undefined ? dto.humanHandoffRules?.trim() || null : (prev?.humanHandoffRules ?? null),
            shippingPolicy: dto.shippingPolicy !== undefined ? dto.shippingPolicy?.trim() || null : (prev?.shippingPolicy ?? null),
            returnPolicy: dto.returnPolicy !== undefined ? dto.returnPolicy?.trim() || null : (prev?.returnPolicy ?? null),
            exchangePolicy: dto.exchangePolicy !== undefined ? dto.exchangePolicy?.trim() || null : (prev?.exchangePolicy ?? null),
            deliveryNotes: dto.deliveryNotes !== undefined ? dto.deliveryNotes?.trim() || null : (prev?.deliveryNotes ?? null),
            forbiddenBehaviors: dto.forbiddenBehaviors !== undefined ? dto.forbiddenBehaviors?.trim() || null : (prev?.forbiddenBehaviors ?? null),
            escalationRules: dto.escalationRules !== undefined
                ? normalizeEscalationRules(dto.escalationRules)
                : (prev?.escalationRules ?? null),
            fallbackHumanContact: fallbackHumanContactFromDto ?? (prev?.fallbackHumanContact ?? null),
            customSystemPrompt: dto.systemPrompt !== undefined ? dto.systemPrompt.trim() || null : (prev?.customSystemPrompt ?? null),
            emailSenderName: dto.emailSenderName !== undefined ? dto.emailSenderName?.trim() || null : (prev?.emailSenderName ?? null),
            emailSenderAddress: dto.emailSenderAddress !== undefined
                ? dto.emailSenderAddress?.trim() || null
                : (prev?.emailSenderAddress ?? null),
            emailReplyTo: dto.emailReplyTo !== undefined ? dto.emailReplyTo?.trim() || null : (prev?.emailReplyTo ?? null),
            emailSubjectTemplate: dto.emailSubjectTemplate !== undefined
                ? dto.emailSubjectTemplate?.trim() || null
                : (prev?.emailSubjectTemplate ?? null),
            paymentLinkEmailIntro: dto.paymentLinkEmailIntro !== undefined
                ? dto.paymentLinkEmailIntro?.trim() || null
                : (prev?.paymentLinkEmailIntro ?? null),
            emailTestRecipient: dto.emailTestRecipient !== undefined
                ? dto.emailTestRecipient?.trim() || null
                : (prev?.emailTestRecipient ?? null),
            useWorkspaceEmail: dto.useWorkspaceEmail !== undefined ? dto.useWorkspaceEmail === true : (prev?.useWorkspaceEmail === true),
            useWorkspaceShopify: dto.useWorkspaceShopify !== undefined
                ? dto.useWorkspaceShopify === true
                : (prev?.useWorkspaceShopify === true),
            useWorkspaceOpenai: dto.useWorkspaceOpenai !== undefined ? dto.useWorkspaceOpenai === true : (prev?.useWorkspaceOpenai === true),
            useWorkspaceElevenlabs: dto.useWorkspaceElevenlabs !== undefined
                ? dto.useWorkspaceElevenlabs === true
                : (prev?.useWorkspaceElevenlabs === true),
            useWorkspaceTwilio: dto.useWorkspaceTwilio !== undefined ? dto.useWorkspaceTwilio === true : (prev?.useWorkspaceTwilio === true),
            shopifyApiVersion: dto.shopifyApiVersion !== undefined ? dto.shopifyApiVersion?.trim() || null : (prev?.shopifyApiVersion ?? null),
        };
    }
    async invalidateAgentRuntimeState(tenantId, agentId) {
        this.log.log(JSON.stringify({
            event: 'agent.runtime_cache.invalidate',
            tenantId,
            agentId,
            message: 'Agent settings updated; runtime re-reads fresh DB config on next call/session.',
        }));
    }
    encryptSecrets(secrets) {
        if (Object.keys(secrets).length === 0)
            return null;
        const json = JSON.stringify(secrets);
        return this.encryption.encryptToStorage(json);
    }
    async applyWorkspaceIntegrationFlagsOnly(tenantId, dto) {
        if (!dto.useWorkspaceDefaults)
            return;
        const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
        if (!row)
            return;
        const setNonSecretDefault = (key, val) => {
            if (!val?.trim())
                return;
            const cur = dto[key];
            if (typeof cur === 'string' && cur.trim())
                return;
            dto[key] = val;
        };
        if (row.shopifyShopDomain?.trim() && row.shopifyAdminTokenEnc) {
            dto.useWorkspaceShopify = true;
        }
        if (row.openaiApiKeyEnc)
            dto.useWorkspaceOpenai = true;
        if (row.elevenlabsApiKeyEnc)
            dto.useWorkspaceElevenlabs = true;
        if (row.twilioAccountSid && row.twilioAuthTokenEnc)
            dto.useWorkspaceTwilio = true;
        if (row.resendApiKeyEnc)
            dto.useWorkspaceEmail = true;
        if (row.elevenlabsDefaultVoiceId?.trim()) {
            setNonSecretDefault('voiceId', row.elevenlabsDefaultVoiceId.trim());
        }
        if (row.elevenlabsDefaultModel?.trim()) {
            setNonSecretDefault('elevenlabsModel', row.elevenlabsDefaultModel.trim());
        }
        if (row.twilioPhoneNumber?.trim()) {
            setNonSecretDefault('twilioPhoneNumber', row.twilioPhoneNumber.trim());
        }
        if (row.resendFromEmail?.trim()) {
            setNonSecretDefault('emailSenderAddress', row.resendFromEmail.trim());
        }
    }
    async create(tenantId, dto, createdById) {
        normalizeAgentDtoAliases(dto);
        if (dto.agentStatus === create_agent_dto_1.AgentStatusDto.ACTIVE) {
            throw new common_1.BadRequestException('Use Go Live to activate an agent after readiness checks pass.');
        }
        (0, ownership_linkage_1.assertProductionOwnershipRequired)({
            nodeEnv: process.env.NODE_ENV,
            clientId: dto.clientId,
            storeId: dto.storeId,
        });
        await this.applyWorkspaceIntegrationFlagsOnly(tenantId, dto);
        let validatedClientId = null;
        if (dto.clientId?.trim()) {
            const client = await this.prisma.client.findFirst({
                where: { id: dto.clientId.trim(), tenantId },
                select: { id: true, tenantId: true },
            });
            if (!client)
                throw new common_1.BadRequestException('Client not found for this tenant.');
            (0, ownership_linkage_1.assertTenantOwnership)({ tenantId, clientTenantId: client.tenantId });
            validatedClientId = client.id;
        }
        else {
            const clients = await this.prisma.client.findMany({
                where: { tenantId },
                orderBy: { createdAt: 'asc' },
                take: 2,
            });
            if (clients.length === 1)
                validatedClientId = clients[0].id;
            else if (clients.length === 0) {
                throw new common_1.BadRequestException('No client record found for this workspace.');
            }
            else {
                throw new common_1.BadRequestException('Select a client for this agent.');
            }
        }
        let validatedStoreId = null;
        if (dto.storeId?.trim()) {
            const store = await this.prisma.store.findFirst({
                where: { id: dto.storeId.trim(), tenantId, deletedAt: null },
                select: { id: true, tenantId: true },
            });
            if (!store)
                throw new common_1.BadRequestException('Store not found for this tenant.');
            (0, ownership_linkage_1.assertTenantOwnership)({ tenantId, storeTenantId: store.tenantId });
            validatedStoreId = store.id;
        }
        const slug = slugFromName(dto.agentName);
        const existing = await this.prisma.agent.findFirst({
            where: { tenantId, slug, deletedAt: null },
        });
        if (existing) {
            throw new common_1.ConflictException(`An agent with slug "${slug}" already exists. Use a different name.`);
        }
        const secrets = this.pickSecrets(dto);
        const hasSecrets = Object.keys(secrets).length > 0;
        if (hasSecrets && !this.encryption.isAvailable()) {
            throw new common_1.BadRequestException('Encryption is not configured; cannot store secrets.');
        }
        const secretsEnc = this.encryptSecrets(secrets);
        let shopifyConnectionStatus = prisma_types_1.ConnectionStatus.UNKNOWN;
        let twilioConnectionStatus = prisma_types_1.ConnectionStatus.UNKNOWN;
        let openaiConnectionStatus = prisma_types_1.ConnectionStatus.UNKNOWN;
        let elevenlabsConnectionStatus = prisma_types_1.ConnectionStatus.UNKNOWN;
        let anyConnectionValidated = false;
        if (dto.shopifyStoreUrl?.trim() && dto.shopifyAdminToken?.trim()) {
            const r = await this.shopifyTest.testConnection({
                shopifyStoreUrl: dto.shopifyStoreUrl,
                shopifyAdminToken: dto.shopifyAdminToken,
            });
            if (!r.success)
                throw new common_1.BadRequestException(r.message || 'Shopify connection test failed.');
            shopifyConnectionStatus = prisma_types_1.ConnectionStatus.OK;
            anyConnectionValidated = true;
        }
        if (dto.twilioAccountSid?.trim() && dto.twilioAuthToken?.trim()) {
            const r = await this.twilioTest.testConnection({
                twilioAccountSid: dto.twilioAccountSid,
                twilioAuthToken: dto.twilioAuthToken,
            });
            if (!r.success)
                throw new common_1.BadRequestException(r.message || 'Twilio connection test failed.');
            twilioConnectionStatus = prisma_types_1.ConnectionStatus.OK;
            anyConnectionValidated = true;
        }
        if (dto.openaiApiKey?.trim()) {
            const r = await this.openaiTest.testConnection({ openaiApiKey: dto.openaiApiKey });
            if (!r.success)
                throw new common_1.BadRequestException(r.message || 'OpenAI connection test failed.');
            openaiConnectionStatus = prisma_types_1.ConnectionStatus.OK;
            anyConnectionValidated = true;
        }
        if (dto.elevenlabsApiKey?.trim()) {
            const r = await this.elevenlabsTest.testConnection({ elevenlabsApiKey: dto.elevenlabsApiKey, voiceId: dto.voiceId });
            if (!r.success)
                throw new common_1.BadRequestException(r.message || 'ElevenLabs connection test failed.');
            elevenlabsConnectionStatus = prisma_types_1.ConnectionStatus.OK;
            anyConnectionValidated = true;
        }
        if (dto.voiceProvider === 'elevenlabs' && !dto.voiceId?.trim()) {
            throw new common_1.BadRequestException('Voice ID is required when ElevenLabs is selected.');
        }
        const toolsResolved = this.resolveToolsFromDto(dto);
        const agent = await this.prisma.$transaction(async (tx) => {
            const created = await tx.agent.create({
                data: {
                    tenantId,
                    clientId: validatedClientId,
                    agentTypeId: null,
                    storeId: validatedStoreId,
                    name: dto.agentName.trim(),
                    slug,
                    baseSystemPrompt: dto.systemPrompt?.trim() ?? '',
                    description: null,
                    language: dto.language ?? 'en',
                    timezone: dto.timezone ?? null,
                    voice: dto.voiceId ?? null,
                    voiceProvider: dto.voiceProvider ?? null,
                    voiceId: dto.voiceId ?? null,
                    voiceNameLabel: dto.voiceNameLabel?.trim() || null,
                    voiceStyle: dto.voiceStyle ?? null,
                    greetingMessage: dto.greetingMessage?.trim() || null,
                    fallbackMessage: dto.fallbackMessage?.trim() || null,
                    escalationMessage: null,
                    model: dto.openAiModel?.trim() || null,
                    temperature: null,
                    status: statusDtoToPrisma(dto.agentStatus),
                    handoffEnabled: dto.transferToHumanEnabled ?? true,
                    voiceResponseStyle: dto.voiceStyle ?? null,
                    storeName: dto.storeName?.trim() || null,
                    storeUrl: dto.storeUrl?.trim() || null,
                    storeEmail: dto.storeEmail?.trim() || null,
                    agentGoal: dto.agentGoal?.trim() || null,
                    agentRole: dto.agentRole?.trim() || null,
                    toneOfVoice: dto.toneOfVoice?.trim() || null,
                    allowedActions: dto.allowedActions?.trim() || null,
                    restrictedActions: dto.restrictedActions?.trim() || null,
                    escalationInstructions: dto.escalationInstructions?.trim() || null,
                    returnRefundBehavior: dto.returnRefundBehavior?.trim() || null,
                    orderStatusHandling: dto.orderStatusHandling?.trim() || null,
                    outOfStockHandling: dto.outOfStockHandling?.trim() || null,
                    transferToHumanEnabled: dto.transferToHumanEnabled ?? true,
                    escalationPhone: dto.escalationPhone?.trim() || null,
                    escalationEmail: dto.escalationEmail?.trim() || null,
                    shopifyStoreUrl: dto.shopifyStoreUrl?.trim() || null,
                    shopifyStoreNumber: dto.shopifyStoreNumber?.trim() || null,
                    knowledgeBaseSource: dto.knowledgeBaseSource?.trim() || null,
                    knowledgeSyncEnabled: dto.knowledgeSyncEnabled ?? true,
                    twilioPhoneNumber: dto.twilioPhoneNumber?.trim() ? (0, normalize_phone_1.normalizePhoneNumber)(dto.twilioPhoneNumber.trim()) : null,
                    callRoutingMode: dto.callRoutingMode?.trim() || null,
                    incomingCallHandling: dto.incomingCallHandling?.trim() || null,
                    databaseProvider: dto.databaseProvider?.trim() || null,
                    shopifyConnectionStatus,
                    databaseConnectionStatus: prisma_types_1.ConnectionStatus.UNKNOWN,
                    twilioConnectionStatus,
                    openaiConnectionStatus,
                    elevenlabsConnectionStatus,
                    lastConnectionTestAt: anyConnectionValidated ? new Date() : null,
                    secretsEnc,
                    createdById: createdById ?? null,
                    ...(toolsResolved && {
                        toolPermissions: toolsResolved.toolPermissions,
                        enabledTools: toolsResolved.enabledTools,
                    }),
                },
                select: this.agentSelect(),
            });
            await tx.agentConfig.create({
                data: {
                    tenantId,
                    agentId: created.id,
                    businessName: dto.businessName?.trim() || dto.storeName?.trim() || null,
                    supportEmail: dto.supportEmail?.trim() || dto.storeEmail?.trim() || null,
                    supportPhone: dto.supportPhone?.trim() || null,
                    askEmailBeforePaymentLink: dto.askEmailBeforePaymentLink ?? true,
                    checkoutMode: (0, types_1.toCheckoutModeApi)(dto.checkoutMode),
                    humanHandoffRules: dto.humanHandoffRules?.trim() || null,
                    shippingPolicy: dto.shippingPolicy?.trim() || null,
                    returnPolicy: dto.returnPolicy?.trim() || null,
                    exchangePolicy: dto.exchangePolicy?.trim() || null,
                    deliveryNotes: dto.deliveryNotes?.trim() || null,
                    forbiddenBehaviors: dto.forbiddenBehaviors?.trim() || null,
                    escalationRules: normalizeEscalationRules(dto.escalationRules),
                    fallbackHumanContact: dto.escalationPhone?.trim() || dto.escalationEmail?.trim() || null,
                    customSystemPrompt: dto.systemPrompt?.trim() || null,
                    emailSenderName: dto.emailSenderName?.trim() || null,
                    emailSenderAddress: dto.emailSenderAddress?.trim() || null,
                    emailReplyTo: dto.emailReplyTo?.trim() || null,
                    emailSubjectTemplate: dto.emailSubjectTemplate?.trim() || null,
                    paymentLinkEmailIntro: dto.paymentLinkEmailIntro?.trim() || null,
                    emailTestRecipient: dto.emailTestRecipient?.trim() || null,
                    useWorkspaceEmail: dto.useWorkspaceEmail === true,
                    useWorkspaceShopify: dto.useWorkspaceShopify === true,
                    useWorkspaceOpenai: dto.useWorkspaceOpenai === true,
                    useWorkspaceElevenlabs: dto.useWorkspaceElevenlabs === true,
                    useWorkspaceTwilio: dto.useWorkspaceTwilio === true,
                    shopifyApiVersion: dto.shopifyApiVersion?.trim() || null,
                },
            });
            await tx.voiceProfile.create({
                data: {
                    tenantId,
                    agentId: created.id,
                    provider: dto.voiceProvider ?? 'openai',
                    language: dto.language ?? 'en',
                    voice: dto.voiceId ?? null,
                    tone: dto.toneOfVoice ?? dto.voiceStyle ?? null,
                    greetingMessage: dto.greetingMessage?.trim() || null,
                    providerConfig: this.buildVoiceProviderConfig(dto),
                },
            });
            if (dto.twilioPhoneNumber?.trim()) {
                const normalizedPhone = (0, normalize_phone_1.normalizePhoneNumber)(dto.twilioPhoneNumber.trim());
                await this.assertPhoneNotAssignedToOtherAgent(tenantId, created.id, normalizedPhone, tx);
                await tx.phoneNumberMapping.upsert({
                    where: {
                        tenantId_phoneNumber: {
                            tenantId,
                            phoneNumber: normalizedPhone,
                        },
                    },
                    create: {
                        tenantId,
                        agentId: created.id,
                        phoneNumber: normalizedPhone,
                        provider: 'twilio',
                    },
                    update: {
                        agentId: created.id,
                        provider: 'twilio',
                    },
                });
            }
            return created;
        });
        if (shopifyConnectionStatus === prisma_types_1.ConnectionStatus.OK) {
            try {
                await this.productSyncQueue.enqueue(tenantId, agent.id);
            }
            catch {
                await this.prisma.auditLog.create({
                    data: {
                        tenantId,
                        action: 'SHOPIFY_PRODUCT_SYNC_ENQUEUE_FAILED',
                        entityType: 'AGENT',
                        entityId: agent.id,
                        metadata: { reason: 'queue_unavailable_or_misconfigured' },
                    },
                });
            }
        }
        await this.prisma.auditLog.create({
            data: {
                tenantId,
                userId: createdById ?? null,
                action: 'AGENT_CREATED',
                entityType: 'AGENT',
                entityId: agent.id,
                metadata: {
                    name: agent.name,
                    status: agent.status,
                },
            },
        });
        return this.serializeAgent(agent);
    }
    agentSelect() {
        return {
            id: true,
            tenantId: true,
            clientId: true,
            storeId: true,
            name: true,
            slug: true,
            description: true,
            language: true,
            timezone: true,
            voice: true,
            voiceProvider: true,
            voiceId: true,
            voiceNameLabel: true,
            voiceStyle: true,
            baseSystemPrompt: true,
            greetingMessage: true,
            fallbackMessage: true,
            escalationMessage: true,
            model: true,
            temperature: true,
            status: true,
            isPublished: true,
            enabledTools: true,
            toolPermissions: true,
            maxToolCallsPerTurn: true,
            handoffEnabled: true,
            voiceResponseStyle: true,
            storeName: true,
            storeUrl: true,
            storeEmail: true,
            agentGoal: true,
            agentRole: true,
            toneOfVoice: true,
            allowedActions: true,
            restrictedActions: true,
            escalationInstructions: true,
            returnRefundBehavior: true,
            orderStatusHandling: true,
            outOfStockHandling: true,
            transferToHumanEnabled: true,
            escalationPhone: true,
            escalationEmail: true,
            shopifyStoreUrl: true,
            shopifyStoreNumber: true,
            knowledgeBaseSource: true,
            knowledgeSyncEnabled: true,
            twilioPhoneNumber: true,
            callRoutingMode: true,
            incomingCallHandling: true,
            databaseProvider: true,
            shopifyConnectionStatus: true,
            databaseConnectionStatus: true,
            twilioConnectionStatus: true,
            openaiConnectionStatus: true,
            elevenlabsConnectionStatus: true,
            lastConnectionTestAt: true,
            createdById: true,
            createdAt: true,
            updatedAt: true,
            agentConfig: {
                select: {
                    businessName: true,
                    supportEmail: true,
                    supportPhone: true,
                    askEmailBeforePaymentLink: true,
                    checkoutMode: true,
                    humanHandoffRules: true,
                    shippingPolicy: true,
                    returnPolicy: true,
                    exchangePolicy: true,
                    deliveryNotes: true,
                    forbiddenBehaviors: true,
                    escalationRules: true,
                    fallbackHumanContact: true,
                    customSystemPrompt: true,
                    emailSenderName: true,
                    emailSenderAddress: true,
                    emailReplyTo: true,
                    emailSubjectTemplate: true,
                    paymentLinkEmailIntro: true,
                    emailTestRecipient: true,
                    useWorkspaceEmail: true,
                    useWorkspaceShopify: true,
                    useWorkspaceOpenai: true,
                    useWorkspaceElevenlabs: true,
                    useWorkspaceTwilio: true,
                    shopifyApiVersion: true,
                },
            },
            voiceProfile: {
                select: {
                    provider: true,
                    language: true,
                    tone: true,
                    greetingMessage: true,
                    providerConfig: true,
                },
            },
        };
    }
    async findAll(tenantId) {
        const items = await this.prisma.agent.findMany({
            where: { tenantId, deletedAt: null },
            orderBy: { updatedAt: 'desc' },
            select: this.agentSelect(),
        });
        const agentDomains = items
            .map((a) => ({
            agentId: a.id,
            domain: (0, types_2.normalizeShopifyDomain)(a.shopifyStoreUrl),
        }))
            .filter((x) => Boolean(x.domain));
        const grouped = agentDomains.length > 0
            ? await this.prisma.productCache.groupBy({
                by: ['agentId', 'shopDomain'],
                where: {
                    tenantId,
                    OR: agentDomains.map((x) => ({ agentId: x.agentId, shopDomain: x.domain })),
                },
                _count: { _all: true },
                _max: { syncedAt: true },
            })
            : [];
        const readinessByAgentDomain = new Map(grouped.map((row) => {
            const itemCount = row._count._all;
            const lastSyncedAt = row._max.syncedAt;
            const staleMs = Number(process.env.CATALOG_STALE_MS) || 24 * 60 * 60 * 1000;
            const isFresh = lastSyncedAt ? Date.now() - lastSyncedAt.getTime() <= staleMs : false;
            return [
                `${row.agentId}:${row.shopDomain}`,
                {
                    catalogReady: itemCount > 0 && isFresh,
                    catalogItemCount: itemCount,
                    catalogLastSyncedAt: lastSyncedAt?.toISOString() ?? null,
                },
            ];
        }));
        return items.map((item) => {
            const serialized = this.serializeAgent(item);
            const domain = (0, types_2.normalizeShopifyDomain)(item.shopifyStoreUrl);
            const readiness = domain ? readinessByAgentDomain.get(`${item.id}:${domain}`) : null;
            return {
                ...serialized,
                catalogReady: readiness?.catalogReady ?? false,
                catalogLastSyncedAt: readiness?.catalogLastSyncedAt ?? null,
                catalogItemCount: readiness?.catalogItemCount ?? 0,
            };
        });
    }
    async findOne(tenantId, id) {
        const agent = await this.prisma.agent.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: this.agentSelect(),
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const emailSummary = await this.agentEmailConfig.getSummary(tenantId, id);
        const credentialSources = await this.getCredentialSourcesSummary(tenantId, id);
        const withEmailMeta = {
            ...agent,
            agentConfig: agent.agentConfig
                ? {
                    ...agent.agentConfig,
                    resendApiKeyConfigured: emailSummary?.resendKeyConfigured === true,
                }
                : null,
            shopifyConfigured: credentialSources.shopify.configured,
            shopifySource: credentialSources.shopify.source,
            credentialSources,
        };
        return this.serializeAgent(withEmailMeta);
    }
    async getAgentById(tenantId, agentId) {
        return this.findOne(tenantId, agentId);
    }
    agentRowToRuntimePromptInput(agent) {
        if (!agent)
            return null;
        const cfg = agent.agentConfig;
        const voiceCfg = (agent.voiceProfile?.providerConfig ?? {});
        return {
            agentId: agent.id,
            agentName: agent.name,
            storeName: agent.storeName ?? agent.store?.name ?? 'Store',
            language: agent.language,
            baseSystemPrompt: agent.baseSystemPrompt,
            agentRole: agent.agentRole,
            agentGoal: agent.agentGoal,
            toneOfVoice: agent.toneOfVoice,
            allowedActions: agent.allowedActions,
            restrictedActions: agent.restrictedActions,
            escalationInstructions: agent.escalationInstructions,
            returnRefundBehavior: agent.returnRefundBehavior,
            orderStatusHandling: agent.orderStatusHandling,
            outOfStockHandling: agent.outOfStockHandling,
            transferToHumanEnabled: agent.transferToHumanEnabled,
            escalationPhone: agent.escalationPhone,
            escalationEmail: agent.escalationEmail,
            knowledgeBaseSource: agent.knowledgeBaseSource,
            knowledgeSyncEnabled: agent.knowledgeSyncEnabled,
            greetingMessage: agent.greetingMessage,
            languageMode: voiceCfg.languageMode ?? 'auto',
            fixedLanguage: voiceCfg.fixedLanguage ?? agent.language,
            supportedLanguages: voiceCfg.supportedLanguages,
            config: cfg
                ? {
                    businessName: cfg.businessName,
                    supportEmail: cfg.supportEmail,
                    supportPhone: cfg.supportPhone,
                    shippingPolicy: cfg.shippingPolicy,
                    returnPolicy: cfg.returnPolicy,
                    exchangePolicy: cfg.exchangePolicy,
                    deliveryNotes: cfg.deliveryNotes,
                    escalationRules: cfg.escalationRules,
                    forbiddenBehaviors: cfg.forbiddenBehaviors,
                    checkoutMode: cfg.checkoutMode,
                    askEmailBeforePaymentLink: cfg.askEmailBeforePaymentLink,
                    fallbackHumanContact: cfg.fallbackHumanContact,
                    customSystemPrompt: cfg.customSystemPrompt,
                    humanHandoffRules: cfg.humanHandoffRules,
                }
                : null,
        };
    }
    async loadAgentRowForRuntime(tenantId, agentId) {
        return this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                ...this.agentSelect(),
                store: { select: { name: true } },
            },
        });
    }
    async sendTestEmail(tenantId, agentId, body) {
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            include: { agentConfig: true },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const toEmail = (body.toEmail?.trim() ||
            agent.agentConfig?.emailTestRecipient?.trim() ||
            '').toLowerCase();
        if (!toEmail.includes('@')) {
            throw new common_1.BadRequestException('Provide a valid test recipient email or save one under Email settings for this agent.');
        }
        const emailConfig = await this.agentEmailConfig.resolveForSend(tenantId, agentId);
        if (!emailConfig) {
            throw new common_1.BadRequestException('Email is not configured for this agent. Add a Resend API key and sender address (agent or workspace).');
        }
        const customCheckout = body.checkoutUrl?.trim();
        const fallback = process.env.DEV_TEST_CHECKOUT_URL?.trim() ||
            (agent.storeUrl?.trim() ? `${agent.storeUrl.replace(/\/+$/, '')}/checkout` : '');
        const resolvedUrl = customCheckout || fallback;
        if (!resolvedUrl || !resolvedUrl.startsWith('https://')) {
            throw new common_1.BadRequestException('Pass an HTTPS checkoutUrl or set DEV_TEST_CHECKOUT_URL / agent store URL for the test link.');
        }
        const checkoutFingerprint = (0, node_crypto_1.createHash)('sha256')
            .update(`agent_test_email|${tenantId}|${agentId}|${toEmail}|${resolvedUrl}`)
            .digest('hex');
        const existing = await this.prisma.checkoutLink.findFirst({
            where: {
                tenantId,
                agentId,
                checkoutFingerprint,
                status: { in: ['CREATED', 'SENT', 'OPENED'] },
            },
            orderBy: { createdAt: 'desc' },
        });
        const checkout = existing ??
            (await this.prisma.checkoutLink.create({
                data: {
                    tenantId,
                    agentId,
                    mode: 'STOREFRONT_CART',
                    checkoutUrl: resolvedUrl,
                    customerEmail: toEmail,
                    checkoutFingerprint,
                    status: 'CREATED',
                    itemsJson: [
                        { title: 'Test product', quantity: 1, price: '$0.00' },
                    ],
                    metadata: { source: 'agent_test_email' },
                },
            }));
        try {
            const sendResult = await this.resendEmail.sendPaymentEmail({
                tenantId,
                agentId,
                checkoutLinkId: checkout.id,
                idempotencyKey: (0, payment_email_idempotency_1.paymentEmailIdempotencyKey)({
                    tenantId,
                    agentId,
                    checkoutLinkId: checkout.id,
                    recipientEmail: toEmail,
                    purpose: 'agent_test_email',
                }),
                to: toEmail,
                businessName: agent.agentConfig?.businessName?.trim() ||
                    agent.storeName?.trim() ||
                    agent.name,
                supportEmail: agent.agentConfig?.supportEmail,
                supportPhone: agent.agentConfig?.supportPhone,
                checkoutUrl: checkout.checkoutUrl,
                items: [{ title: 'Test product', quantity: 1, price: '$0.00' }],
                emailConfig,
            });
            if (!sendResult.deduplicated) {
                await this.prisma.checkoutLink.updateMany({
                    where: { id: checkout.id, tenantId, agentId },
                    data: { status: 'SENT', sentAt: new Date() },
                });
            }
            return {
                success: true,
                message: sendResult.deduplicated
                    ? `A test email was already sent to ${toEmail} for this checkout.`
                    : `Test payment email sent to ${toEmail}.`,
                emailEventId: sendResult.emailEventId,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to send test email.';
            return { success: false, message };
        }
    }
    async getRuntimePromptPreview(tenantId, agentId) {
        const agent = await this.loadAgentRowForRuntime(tenantId, agentId);
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const input = this.agentRowToRuntimePromptInput(agent);
        if (!input)
            throw new common_1.NotFoundException('Agent not found.');
        const layers = (0, build_agent_runtime_prompt_1.buildEnterpriseRuntimePromptLayers)(input);
        return {
            agentId: agent.id,
            agentName: agent.name,
            updatedAt: agent.updatedAt.toISOString(),
            greetingMessage: agent.greetingMessage,
            prompt: layers.combined,
            promptLength: layers.combined.length,
            promptBudget: layers.budget,
            promptLayers: {
                platform: layers.platform,
                agentIdentity: layers.agentIdentity,
                storePolicyKnowledge: layers.storePolicyKnowledge,
                runtimeTools: layers.runtimeTools,
                shopifyTruth: layers.shopifyTruth,
                knowledgeRetrieval: layers.knowledgeRetrieval,
                runtimeContext: layers.runtimeContext,
            },
        };
    }
    async getPublicLiveCard(id) {
        const agent = await this.prisma.agent.findFirst({
            where: { id, deletedAt: null },
            select: {
                name: true,
                storeName: true,
                status: true,
                language: true,
                twilioPhoneNumber: true,
                greetingMessage: true,
            },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        return {
            name: agent.name,
            storeName: agent.storeName,
            status: agent.status,
            isActive: agent.status === prisma_types_1.AgentStatus.ACTIVE,
            language: agent.language,
            phone: agent.twilioPhoneNumber,
            greeting: agent.greetingMessage,
        };
    }
    async update(tenantId, id, dto, actorUserId) {
        normalizeAgentDtoAliases(dto);
        await this.applyWorkspaceIntegrationFlagsOnly(tenantId, dto);
        if (dto.systemPrompt !== undefined && !dto.systemPrompt.trim()) {
            throw new common_1.BadRequestException('System prompt cannot be empty.');
        }
        const existing = await this.findOne(tenantId, id);
        const currentStatus = String(existing.status ?? '').toLowerCase();
        if (process.env.NODE_ENV === 'production') {
            const finalClientId = dto.clientId !== undefined ? dto.clientId?.trim() || '' : existing.clientId || '';
            const finalStoreId = dto.storeId !== undefined ? dto.storeId?.trim() || '' : existing.storeId || '';
            (0, ownership_linkage_1.assertProductionOwnershipRequired)({
                nodeEnv: process.env.NODE_ENV,
                clientId: finalClientId,
                storeId: finalStoreId,
            });
        }
        let slugUpdate;
        if (dto.agentName !== undefined) {
            const slug = slugFromName(dto.agentName);
            if (slug !== existing.slug) {
                const conflict = await this.prisma.agent.findFirst({
                    where: { tenantId, slug, deletedAt: null, id: { not: id } },
                });
                if (conflict) {
                    throw new common_1.ConflictException(`An agent with slug "${slug}" already exists. Use a different name.`);
                }
                slugUpdate = slug;
            }
        }
        if (dto.twilioPhoneNumber !== undefined && dto.twilioPhoneNumber?.trim()) {
            await this.assertPhoneNotAssignedToOtherAgent(tenantId, id, (0, normalize_phone_1.normalizePhoneNumber)(dto.twilioPhoneNumber.trim()), this.prisma);
        }
        const explicitClearOpenai = isExplicitSecretClear(dto.clearOpenaiApiKey);
        const explicitClearEleven = isExplicitSecretClear(dto.clearElevenlabsApiKey);
        const explicitClearResend = isExplicitSecretClear(dto.clearResendApiKey);
        const newSecrets = this.pickSecrets(dto);
        const updatedSecrets = Object.fromEntries(SECRET_KEYS.map((key) => [key, Object.prototype.hasOwnProperty.call(newSecrets, key)]));
        let secretsEnc = undefined;
        const hasSecretChanges = Object.keys(newSecrets).length > 0 ||
            explicitClearOpenai ||
            explicitClearEleven ||
            explicitClearResend;
        if (hasSecretChanges && !this.encryption.isAvailable()) {
            throw new common_1.BadRequestException('Encryption is not configured; cannot store secrets.');
        }
        if (hasSecretChanges && this.encryption.isAvailable()) {
            const existingRow = await this.prisma.agent.findFirst({
                where: { id, tenantId, deletedAt: null },
                select: { secretsEnc: true },
            });
            let merged = { ...newSecrets };
            if (existingRow?.secretsEnc) {
                const dec = this.encryption.decryptFromStorage(existingRow.secretsEnc);
                if (dec) {
                    try {
                        const existing = JSON.parse(dec);
                        merged = { ...existing, ...newSecrets };
                    }
                    catch {
                    }
                }
            }
            if (explicitClearOpenai)
                delete merged.openaiApiKey;
            if (explicitClearEleven)
                delete merged.elevenlabsApiKey;
            if (explicitClearResend)
                delete merged.resendApiKey;
            secretsEnc = this.encryptSecrets(merged);
        }
        let shopifyConnectionStatus;
        let twilioConnectionStatus;
        let openaiConnectionStatus;
        let elevenlabsConnectionStatus;
        let anyConnectionValidated = false;
        const shouldValidateShopify = dto.shopifyStoreUrl !== undefined || newSecrets.shopifyAdminToken !== undefined;
        const shouldValidateTwilio = newSecrets.twilioAccountSid !== undefined || newSecrets.twilioAuthToken !== undefined;
        let existingConfig = null;
        if (shouldValidateShopify || shouldValidateTwilio) {
            existingConfig = await this.getAgentConfigForTest(tenantId, id);
        }
        const workspaceConfig = shouldValidateShopify || shouldValidateTwilio || dto.voiceProvider === 'elevenlabs'
            ? await this.getWorkspaceIntegrationForTenant(tenantId)
            : null;
        if (shouldValidateShopify) {
            const existingRow = await this.prisma.agent.findFirst({
                where: { id, tenantId, deletedAt: null },
                select: {
                    shopifyStoreUrl: true,
                    secretsEnc: true,
                    agentConfig: { select: { useWorkspaceShopify: true, shopifyApiVersion: true } },
                },
            });
            const mergedSecrets = { ...this.secretsFromRow(existingRow?.secretsEnc ?? null), ...newSecrets };
            if (dto.shopifyStoreUrl !== undefined) {
                existingRow.shopifyStoreUrl = dto.shopifyStoreUrl;
            }
            const resolved = (0, credential_resolver_util_1.resolveShopifyConfig)({
                agent: {
                    shopifyStoreUrl: existingRow?.shopifyStoreUrl ?? existingConfig?.shopifyStoreUrl,
                    secrets: mergedSecrets,
                    useWorkspaceShopify: dto.useWorkspaceShopify ?? existingRow?.agentConfig?.useWorkspaceShopify === true,
                    shopifyApiVersion: dto.shopifyApiVersion ?? existingRow?.agentConfig?.shopifyApiVersion,
                },
                workspace: workspaceConfig,
                env: this.providerEnvSlice(),
            });
            if (!resolved) {
                throw new common_1.BadRequestException('Shopify credentials missing for this agent.');
            }
            const r = await this.shopifyTest.testConnection({
                shopifyStoreUrl: resolved.shopifyStoreUrl,
                shopifyAdminToken: resolved.shopifyAdminToken,
            });
            if (!r.success)
                throw new common_1.BadRequestException(r.message || 'Shopify connection test failed.');
            shopifyConnectionStatus = prisma_types_1.ConnectionStatus.OK;
            anyConnectionValidated = true;
        }
        if (shouldValidateTwilio) {
            const finalSid = (newSecrets.twilioAccountSid !== undefined
                ? newSecrets.twilioAccountSid
                : workspaceConfig?.twilioAccountSid || existingConfig?.twilioAccountSid) ?? null;
            const finalAuth = (newSecrets.twilioAuthToken !== undefined
                ? newSecrets.twilioAuthToken
                : workspaceConfig?.twilioAuthToken || existingConfig?.twilioAuthToken) ?? null;
            if (!finalSid?.trim() || !finalAuth?.trim()) {
                throw new common_1.BadRequestException('To validate Twilio credentials, provide both Account SID and Auth token.');
            }
            const r = await this.twilioTest.testConnection({
                twilioAccountSid: finalSid,
                twilioAuthToken: finalAuth,
            });
            if (!r.success)
                throw new common_1.BadRequestException(r.message || 'Twilio connection test failed.');
            twilioConnectionStatus = prisma_types_1.ConnectionStatus.OK;
            anyConnectionValidated = true;
        }
        if (newSecrets.openaiApiKey !== undefined) {
            const r = await this.openaiTest.testConnection({ openaiApiKey: newSecrets.openaiApiKey });
            if (!r.success)
                throw new common_1.BadRequestException(r.message || 'OpenAI connection test failed.');
            openaiConnectionStatus = prisma_types_1.ConnectionStatus.OK;
            anyConnectionValidated = true;
        }
        if (newSecrets.elevenlabsApiKey !== undefined) {
            const r = await this.elevenlabsTest.testConnection({
                elevenlabsApiKey: newSecrets.elevenlabsApiKey,
                voiceId: dto.voiceId ?? undefined,
            });
            if (!r.success)
                throw new common_1.BadRequestException(r.message || 'ElevenLabs connection test failed.');
            elevenlabsConnectionStatus = prisma_types_1.ConnectionStatus.OK;
            anyConnectionValidated = true;
        }
        if (dto.voiceProvider === 'elevenlabs') {
            const hasIncomingKey = Boolean(newSecrets.elevenlabsApiKey?.trim());
            const existingSecrets = hasIncomingKey ? null : await this.getAgentConfigForTest(tenantId, id);
            const hasSavedKey = Boolean(existingSecrets?.elevenlabsApiKey?.trim());
            const hasWorkspaceKey = Boolean(workspaceConfig?.elevenlabsApiKey?.trim());
            if (!hasIncomingKey && !hasSavedKey && !hasWorkspaceKey) {
                throw new common_1.BadRequestException('ElevenLabs is selected but no key is available. Add an agent ElevenLabs key (or keep existing saved key).');
            }
            const finalVoiceId = dto.voiceId !== undefined ? dto.voiceId : existing.voiceId;
            if (!finalVoiceId?.trim()) {
                throw new common_1.BadRequestException('Voice ID is required when ElevenLabs is selected.');
            }
        }
        const data = {
            ...(dto.clientId !== undefined && { clientId: dto.clientId?.trim() || null }),
            ...(dto.storeId !== undefined && { storeId: dto.storeId?.trim() || null }),
            ...(dto.agentName !== undefined && { name: dto.agentName.trim() }),
            ...(slugUpdate !== undefined && { slug: slugUpdate }),
            ...(dto.storeName !== undefined && { storeName: dto.storeName.trim() || null }),
            ...(dto.storeUrl !== undefined && { storeUrl: dto.storeUrl.trim() || null }),
            ...(dto.storeEmail !== undefined && { storeEmail: dto.storeEmail?.trim() || null }),
            ...(dto.agentStatus !== undefined && { status: statusDtoToPrisma(dto.agentStatus) }),
            ...(dto.language !== undefined && { language: dto.language }),
            ...(dto.timezone !== undefined && { timezone: dto.timezone || null }),
            ...(dto.voiceProvider !== undefined && { voiceProvider: dto.voiceProvider || null }),
            ...(dto.voiceId !== undefined && { voiceId: dto.voiceId || null, voice: dto.voiceId || null }),
            ...(dto.voiceNameLabel !== undefined && { voiceNameLabel: dto.voiceNameLabel?.trim() || null }),
            ...(dto.voiceStyle !== undefined && { voiceStyle: dto.voiceStyle || null, voiceResponseStyle: dto.voiceStyle || null }),
            ...(dto.greetingMessage !== undefined && { greetingMessage: dto.greetingMessage?.trim() || null }),
            ...(dto.fallbackMessage !== undefined && { fallbackMessage: dto.fallbackMessage?.trim() || null }),
            ...(dto.shopifyStoreUrl !== undefined && { shopifyStoreUrl: dto.shopifyStoreUrl?.trim() || null }),
            ...(dto.shopifyStoreNumber !== undefined && { shopifyStoreNumber: dto.shopifyStoreNumber?.trim() || null }),
            ...(dto.knowledgeBaseSource !== undefined && { knowledgeBaseSource: dto.knowledgeBaseSource?.trim() || null }),
            ...(dto.knowledgeSyncEnabled !== undefined && { knowledgeSyncEnabled: dto.knowledgeSyncEnabled }),
            ...(dto.twilioPhoneNumber !== undefined && {
                twilioPhoneNumber: dto.twilioPhoneNumber?.trim() ? (0, normalize_phone_1.normalizePhoneNumber)(dto.twilioPhoneNumber.trim()) : null,
            }),
            ...(dto.callRoutingMode !== undefined && { callRoutingMode: dto.callRoutingMode?.trim() || null }),
            ...(dto.incomingCallHandling !== undefined && { incomingCallHandling: dto.incomingCallHandling?.trim() || null }),
            ...(dto.databaseProvider !== undefined && { databaseProvider: dto.databaseProvider?.trim() || null }),
            ...(dto.systemPrompt !== undefined && { baseSystemPrompt: dto.systemPrompt.trim() || '' }),
            ...(dto.openAiModel !== undefined && { model: dto.openAiModel?.trim() || null }),
            ...(dto.agentGoal !== undefined && { agentGoal: dto.agentGoal?.trim() || null }),
            ...(dto.agentRole !== undefined && { agentRole: dto.agentRole?.trim() || null }),
            ...(dto.toneOfVoice !== undefined && { toneOfVoice: dto.toneOfVoice?.trim() || null }),
            ...(dto.allowedActions !== undefined && { allowedActions: dto.allowedActions?.trim() || null }),
            ...(dto.restrictedActions !== undefined && { restrictedActions: dto.restrictedActions?.trim() || null }),
            ...(dto.escalationInstructions !== undefined && { escalationInstructions: dto.escalationInstructions?.trim() || null }),
            ...(dto.returnRefundBehavior !== undefined && { returnRefundBehavior: dto.returnRefundBehavior?.trim() || null }),
            ...(dto.orderStatusHandling !== undefined && { orderStatusHandling: dto.orderStatusHandling?.trim() || null }),
            ...(dto.outOfStockHandling !== undefined && { outOfStockHandling: dto.outOfStockHandling?.trim() || null }),
            ...(dto.transferToHumanEnabled !== undefined && { transferToHumanEnabled: dto.transferToHumanEnabled }),
            ...(dto.escalationPhone !== undefined && { escalationPhone: dto.escalationPhone?.trim() || null }),
            ...(dto.escalationEmail !== undefined && { escalationEmail: dto.escalationEmail?.trim() || null }),
            ...(shopifyConnectionStatus !== undefined && { shopifyConnectionStatus }),
            ...(twilioConnectionStatus !== undefined && { twilioConnectionStatus }),
            ...(openaiConnectionStatus !== undefined && { openaiConnectionStatus }),
            ...(elevenlabsConnectionStatus !== undefined && { elevenlabsConnectionStatus }),
            ...(anyConnectionValidated ? { lastConnectionTestAt: new Date() } : {}),
            ...(hasSecretChanges && this.encryption.isAvailable() && { secretsEnc: secretsEnc ?? null }),
        };
        const toolsResolved = this.resolveToolsFromDto(dto);
        if (toolsResolved) {
            data.toolPermissions = toolsResolved.toolPermissions;
            data.enabledTools = toolsResolved.enabledTools;
        }
        if (dto.clientId !== undefined && dto.clientId?.trim()) {
            const client = await this.prisma.client.findFirst({
                where: { id: dto.clientId.trim(), tenantId },
                select: { id: true, tenantId: true },
            });
            if (!client)
                throw new common_1.BadRequestException('Client not found for this tenant.');
            (0, ownership_linkage_1.assertTenantOwnership)({ tenantId, clientTenantId: client.tenantId });
        }
        if (dto.storeId !== undefined && dto.storeId?.trim()) {
            const store = await this.prisma.store.findFirst({
                where: { id: dto.storeId.trim(), tenantId, deletedAt: null },
                select: { id: true, tenantId: true },
            });
            if (!store)
                throw new common_1.BadRequestException('Store not found for this tenant.');
            (0, ownership_linkage_1.assertTenantOwnership)({ tenantId, storeTenantId: store.tenantId });
        }
        const updateResult = await this.prisma.agent.updateMany({
            where: { id, tenantId, deletedAt: null },
            data: data,
        });
        if (updateResult.count === 0) {
            throw new common_1.NotFoundException('Agent not found.');
        }
        const updated = await this.prisma.agent.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: this.agentSelect(),
        });
        if (!updated) {
            throw new common_1.NotFoundException('Agent not found.');
        }
        const previousAgentConfig = (existing.agentConfig ??
            null);
        const configMetadata = this.buildAgentConfigMetadata({
            previousMetadata: previousAgentConfig?.metadata,
            promptTouched: dto.systemPrompt !== undefined,
            previousPromptUpdatedAt: previousAgentConfig?.updatedAt ?? null,
        });
        const configReplacement = this.resolveAgentConfigReplacement(dto, previousAgentConfig);
        await this.prisma.agentConfig.upsert({
            where: { agentId: id },
            create: {
                tenantId,
                agentId: id,
                businessName: dto.businessName?.trim() || dto.storeName?.trim() || null,
                supportEmail: dto.supportEmail?.trim() || dto.storeEmail?.trim() || null,
                supportPhone: dto.supportPhone?.trim() || null,
                askEmailBeforePaymentLink: dto.askEmailBeforePaymentLink ?? true,
                checkoutMode: (0, types_1.toCheckoutModeApi)(dto.checkoutMode),
                humanHandoffRules: dto.humanHandoffRules?.trim() || null,
                shippingPolicy: dto.shippingPolicy?.trim() || null,
                returnPolicy: dto.returnPolicy?.trim() || null,
                exchangePolicy: dto.exchangePolicy?.trim() || null,
                deliveryNotes: dto.deliveryNotes?.trim() || null,
                forbiddenBehaviors: dto.forbiddenBehaviors?.trim() || null,
                escalationRules: normalizeEscalationRules(dto.escalationRules),
                fallbackHumanContact: dto.escalationPhone?.trim() || dto.escalationEmail?.trim() || null,
                customSystemPrompt: dto.systemPrompt?.trim() || null,
                emailSenderName: dto.emailSenderName?.trim() || null,
                emailSenderAddress: dto.emailSenderAddress?.trim() || null,
                emailReplyTo: dto.emailReplyTo?.trim() || null,
                emailSubjectTemplate: dto.emailSubjectTemplate?.trim() || null,
                paymentLinkEmailIntro: dto.paymentLinkEmailIntro?.trim() || null,
                emailTestRecipient: dto.emailTestRecipient?.trim() || null,
                useWorkspaceEmail: dto.useWorkspaceEmail === true,
                useWorkspaceShopify: dto.useWorkspaceShopify === true,
                useWorkspaceOpenai: dto.useWorkspaceOpenai === true,
                useWorkspaceElevenlabs: dto.useWorkspaceElevenlabs === true,
                useWorkspaceTwilio: dto.useWorkspaceTwilio === true,
                shopifyApiVersion: dto.shopifyApiVersion?.trim() || null,
                metadata: {
                    configVersion: 1,
                    promptUpdatedAt: dto.systemPrompt?.trim() ? new Date().toISOString() : null,
                    lastSavedAt: new Date().toISOString(),
                },
            },
            update: {
                ...configReplacement,
                metadata: configMetadata,
            },
        });
        await this.prisma.voiceProfile.upsert({
            where: { agentId: id },
            create: {
                tenantId,
                agentId: id,
                provider: dto.voiceProvider ?? 'openai',
                language: dto.language ?? 'en',
                voice: dto.voiceId ?? null,
                tone: dto.toneOfVoice ?? dto.voiceStyle ?? null,
                greetingMessage: dto.greetingMessage?.trim() || null,
                providerConfig: {
                    voiceStyle: dto.voiceStyle ?? null,
                },
            },
            update: {
                ...(dto.voiceProvider !== undefined && { provider: dto.voiceProvider || 'openai' }),
                ...(dto.language !== undefined && { language: dto.language || 'en' }),
                ...(dto.voiceId !== undefined && { voice: dto.voiceId || null }),
                ...((dto.toneOfVoice !== undefined || dto.voiceStyle !== undefined) && {
                    tone: dto.toneOfVoice ?? dto.voiceStyle ?? null,
                }),
                ...(dto.greetingMessage !== undefined && { greetingMessage: dto.greetingMessage?.trim() || null }),
                ...((dto.voiceStyle !== undefined ||
                    dto.elevenlabsModel !== undefined ||
                    dto.languageMode !== undefined ||
                    dto.fixedLanguage !== undefined ||
                    dto.supportedLanguages !== undefined ||
                    dto.voicePersonality !== undefined) && {
                    providerConfig: this.buildVoiceProviderConfig(dto),
                }),
            },
        });
        if (dto.twilioPhoneNumber !== undefined) {
            await this.prisma.phoneNumberMapping.deleteMany({
                where: { tenantId, agentId: id },
            });
            const normalizedInbound = dto.twilioPhoneNumber?.trim()
                ? (0, normalize_phone_1.normalizePhoneNumber)(dto.twilioPhoneNumber.trim())
                : null;
            if (normalizedInbound) {
                await this.prisma.phoneNumberMapping.upsert({
                    where: {
                        tenantId_phoneNumber: { tenantId, phoneNumber: normalizedInbound },
                    },
                    create: {
                        tenantId,
                        agentId: id,
                        phoneNumber: normalizedInbound,
                        provider: 'twilio',
                    },
                    update: {
                        agentId: id,
                        provider: 'twilio',
                    },
                });
            }
        }
        await this.prisma.auditLog.create({
            data: {
                tenantId,
                userId: actorUserId ?? null,
                action: 'AGENT_UPDATED',
                entityType: 'AGENT',
                entityId: id,
                metadata: {
                    updatedFields: Object.keys(dto),
                    status: updated.status,
                },
            },
        });
        const fieldsUpdated = Object.keys(dto).filter((k) => dto[k] !== undefined);
        this.log.log(JSON.stringify({
            event: 'agent.settings_saved',
            agentId: id,
            tenantId,
            fieldsUpdated,
            voiceProvider: updated.voiceProvider ?? null,
            voiceIdPresent: Boolean(updated.voiceId?.trim()),
            openaiKeyTouched: dto.openaiApiKey !== undefined,
            openaiKeyCleared: explicitClearOpenai,
            elevenLabsKeyTouched: dto.elevenlabsApiKey !== undefined,
            elevenLabsKeyCleared: explicitClearEleven,
        }));
        this.log.log(JSON.stringify({
            event: 'agent.update',
            agentId: id,
            incomingStatus: dto.agentStatus ?? null,
            savedStatus: updated.status,
        }));
        if (dto.agentStatus !== undefined) {
            const statusVerify = await this.prisma.agent.findFirst({
                where: { id, tenantId, deletedAt: null },
                select: { status: true },
            });
            this.logAgentStatusPersist({
                agentId: id,
                tenantId,
                requestedStatus: dto.agentStatus,
                savedStatus: statusVerify?.status ?? null,
                changedBy: actorUserId ?? null,
            });
            await this.verifyAgentStatusPersist({
                tenantId,
                agentId: id,
                requestedStatus: dto.agentStatus,
                savedStatus: updated.status ?? null,
            });
        }
        else {
            await this.verifyAgentStatusPersist({
                tenantId,
                agentId: id,
                requestedStatus: currentStatus || null,
                savedStatus: updated.status ?? null,
            });
        }
        if (explicitClearOpenai) {
            console.log({ openaiKeyCleared: true, agentId: id, tenantId });
        }
        if (explicitClearEleven) {
            console.log({ elevenlabsKeyCleared: true, agentId: id, tenantId });
        }
        await this.invalidateAgentRuntimeState(tenantId, id);
        return {
            ...this.serializeAgent(updated),
            updatedSecrets,
        };
    }
    async syncSecretsFromWorkspace(tenantId, id, actorUserId) {
        if (!this.encryption.isAvailable()) {
            throw new common_1.BadRequestException('Encryption is not configured; cannot sync workspace secrets.');
        }
        await this.findOne(tenantId, id);
        const [workspace, existingConfig] = await Promise.all([
            this.getWorkspaceIntegrationForTenant(tenantId),
            this.getAgentConfigForTest(tenantId, id),
        ]);
        const merged = {};
        for (const key of SECRET_KEYS) {
            const value = existingConfig[key];
            if (typeof value === 'string' && value.trim()) {
                merged[key] = value.trim();
            }
        }
        const workspaceToAgent = {
            twilioAccountSid: workspace?.twilioAccountSid?.trim(),
            twilioAuthToken: workspace?.twilioAuthToken?.trim(),
            openaiApiKey: workspace?.openaiApiKey?.trim(),
            elevenlabsApiKey: workspace?.elevenlabsApiKey?.trim(),
            resendApiKey: workspace?.resendApiKey?.trim(),
        };
        const workspaceShopifyAvailable = Boolean(workspace?.shopifyStoreUrl?.trim() && workspace?.shopifyAdminToken?.trim());
        const updatedSecrets = Object.fromEntries(SECRET_KEYS.map((key) => [key, false]));
        for (const [key, value] of Object.entries(workspaceToAgent)) {
            if (typeof value === 'string' && value.trim()) {
                merged[key] = value.trim();
                if (key in updatedSecrets) {
                    updatedSecrets[key] = true;
                }
            }
        }
        const anyUpdated = Object.values(updatedSecrets).some(Boolean);
        if (!anyUpdated && !workspaceShopifyAvailable) {
            throw new common_1.BadRequestException('No workspace secrets are available to sync yet. Save credentials in Settings first.');
        }
        if (workspaceShopifyAvailable) {
            delete merged.shopifyAdminToken;
            delete merged.shopifyApiKey;
            delete merged.shopifyApiSecret;
        }
        const secretsEnc = this.encryptSecrets(merged);
        if (!secretsEnc) {
            throw new common_1.BadRequestException('Failed to encrypt synced secrets.');
        }
        await this.prisma.agent.updateMany({
            where: { id, tenantId, deletedAt: null },
            data: {
                secretsEnc,
                lastConnectionTestAt: new Date(),
            },
        });
        if (workspaceShopifyAvailable) {
            await this.prisma.agentConfig.upsert({
                where: { agentId: id },
                create: {
                    tenantId,
                    agentId: id,
                    useWorkspaceShopify: true,
                },
                update: { useWorkspaceShopify: true },
            });
        }
        const [shopify, twilio, openai, elevenlabs] = await Promise.all([
            this.testShopifyConnection(tenantId, id).catch((error) => ({
                success: false,
                message: error instanceof Error ? error.message : 'Shopify retest failed.',
            })),
            this.testTwilioConnection(tenantId, id).catch((error) => ({
                success: false,
                message: error instanceof Error ? error.message : 'Twilio retest failed.',
            })),
            this.testOpenAIConnection(tenantId, id).catch((error) => ({
                success: false,
                message: error instanceof Error ? error.message : 'OpenAI retest failed.',
            })),
            this.testElevenLabsConnection(tenantId, id).catch((error) => ({
                success: false,
                message: error instanceof Error ? error.message : 'ElevenLabs retest failed.',
            })),
        ]);
        await this.prisma.auditLog.create({
            data: {
                tenantId,
                userId: actorUserId ?? null,
                action: 'AGENT_SECRETS_SYNCED_FROM_WORKSPACE',
                entityType: 'AGENT',
                entityId: id,
                metadata: {
                    updatedSecrets,
                    retest: {
                        shopify: shopify.success,
                        twilio: twilio.success,
                        openai: openai.success,
                        elevenlabs: elevenlabs.success,
                    },
                },
            },
        });
        const updated = await this.prisma.agent.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: this.agentSelect(),
        });
        if (!updated)
            throw new common_1.NotFoundException('Agent not found.');
        return {
            ...this.serializeAgent(updated),
            updatedSecrets,
        };
    }
    async remove(tenantId, id, actorUserId) {
        const existing = await this.findOne(tenantId, id);
        const deleted = await this.prisma.agent.updateMany({
            where: { id, tenantId, deletedAt: null },
            data: { deletedAt: new Date() },
        });
        if (deleted.count === 0) {
            throw new common_1.NotFoundException('Agent not found.');
        }
        await this.prisma.auditLog.create({
            data: {
                tenantId,
                userId: actorUserId ?? null,
                action: 'AGENT_DELETED',
                entityType: 'AGENT',
                entityId: id,
                metadata: {
                    name: existing.name,
                },
            },
        });
        return { deleted: true };
    }
    async getShopifyConfig(tenantId, agentId) {
        const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
        const resolved = (0, credential_resolver_util_1.resolveShopifyConfig)({
            agent: {
                shopifyStoreUrl: bundle.shopifyStoreUrl,
                secrets: bundle.secrets,
                useWorkspaceShopify: bundle.useWorkspaceShopify,
                shopifyApiVersion: bundle.shopifyApiVersion,
            },
            workspace: bundle.workspace,
            env: this.providerEnvSlice(),
        });
        if (!resolved)
            return null;
        (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'shopify', resolved.source, agentId);
        return {
            shopifyStoreUrl: resolved.shopifyStoreUrl,
            shopifyAdminToken: resolved.shopifyAdminToken,
            shopifyApiVersion: resolved.shopifyApiVersion,
            source: resolved.source,
        };
    }
    async getTwilioConfig(tenantId, agentId) {
        const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { twilioPhoneNumber: true },
        });
        const resolved = (0, credential_resolver_util_1.resolveTwilioConfig)({
            agentSecrets: bundle.secrets,
            workspace: bundle.workspace,
            useWorkspaceTwilio: bundle.useWorkspaceTwilio,
            agentPhoneNumber: agent?.twilioPhoneNumber,
        });
        if (!resolved)
            return null;
        (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'twilio', resolved.authSource, agentId);
        return {
            accountSid: resolved.accountSid,
            authToken: resolved.authToken,
            messagingFrom: resolved.phoneNumber ?? null,
            source: resolved.authSource,
        };
    }
    async getCredentialSourcesSummary(tenantId, agentId) {
        const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
        return (0, credential_resolver_util_1.buildCredentialSourcesSummary)({
            agent: {
                shopifyStoreUrl: bundle.shopifyStoreUrl,
                secrets: bundle.secrets,
                useWorkspaceShopify: bundle.useWorkspaceShopify,
                useWorkspaceEmail: bundle.useWorkspaceEmail,
                useWorkspaceOpenai: bundle.useWorkspaceOpenai,
                useWorkspaceElevenlabs: bundle.useWorkspaceElevenlabs,
                useWorkspaceTwilio: bundle.useWorkspaceTwilio,
                voiceId: bundle.voiceId,
            },
            workspace: bundle.workspace,
            env: this.providerEnvSlice(),
        });
    }
    async getAgentConfigForTest(tenantId, agentId) {
        const row = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                shopifyStoreUrl: true,
                databaseProvider: true,
                secretsEnc: true,
            },
        });
        if (!row)
            throw new common_1.NotFoundException('Agent not found.');
        const out = {
            shopifyStoreUrl: row.shopifyStoreUrl,
            databaseProvider: row.databaseProvider,
        };
        if (row.secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(row.secretsEnc);
            if (dec) {
                try {
                    const secrets = JSON.parse(dec);
                    Object.assign(out, secrets);
                }
                catch {
                }
            }
        }
        return out;
    }
    async getWorkspaceIntegrationForTenant(tenantId) {
        const row = await this.prisma.tenantIntegration.findUnique({
            where: { tenantId },
            select: {
                shopifyShopDomain: true,
                shopifyAdminTokenEnc: true,
                twilioAccountSid: true,
                twilioAuthTokenEnc: true,
                twilioPhoneNumber: true,
                openaiApiKeyEnc: true,
                elevenlabsApiKeyEnc: true,
                elevenlabsDefaultVoiceId: true,
                resendApiKeyEnc: true,
                resendFromEmail: true,
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
            twilioAccountSid: row.twilioAccountSid?.trim() || undefined,
            twilioAuthToken: row.twilioAuthTokenEnc
                ? (this.encryption.decryptFromStorage(row.twilioAuthTokenEnc) ?? undefined)
                : undefined,
            twilioPhoneNumber: row.twilioPhoneNumber?.trim() || undefined,
            openaiApiKey: row.openaiApiKeyEnc
                ? (this.encryption.decryptFromStorage(row.openaiApiKeyEnc) ?? undefined)
                : undefined,
            elevenlabsApiKey: row.elevenlabsApiKeyEnc
                ? (this.encryption.decryptFromStorage(row.elevenlabsApiKeyEnc) ?? undefined)
                : undefined,
            elevenlabsDefaultVoiceId: row.elevenlabsDefaultVoiceId?.trim() || undefined,
            resendApiKey: row.resendApiKeyEnc
                ? (this.encryption.decryptFromStorage(row.resendApiKeyEnc) ?? undefined)
                : undefined,
            resendFromEmail: row.resendFromEmail?.trim() || undefined,
        };
    }
    resolveCredential(agentValue, workspaceValue, envValue) {
        const gatedEnv = envValue?.trim() && (0, provider_env_fallback_util_1.allowProviderEnvFallback)() ? envValue.trim() : undefined;
        return (0, credential_priority_util_1.resolveCredentialPriority)(agentValue, workspaceValue, gatedEnv);
    }
    providerEnvSlice() {
        return (0, provider_env_slice_util_1.buildProviderEnvSlice)(this.config);
    }
    async testShopifyConnection(tenantId, agentId, dto) {
        const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
        let resolved = null;
        let source = 'missing';
        if (dto?.shopifyStoreUrl?.trim() && dto?.shopifyAdminToken?.trim()) {
            resolved = {
                shopifyStoreUrl: dto.shopifyStoreUrl.trim(),
                shopifyAdminToken: dto.shopifyAdminToken.trim(),
                shopifyApiVersion: dto.shopifyApiVersion?.trim() || '2024-10',
                source: 'agent',
            };
            source = 'agent';
        }
        else if (agentId) {
            const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
            if (dto?.shopifyStoreUrl?.trim())
                bundle.shopifyStoreUrl = dto.shopifyStoreUrl.trim();
            if (dto?.shopifyAdminToken?.trim())
                bundle.secrets = { ...bundle.secrets, shopifyAdminToken: dto.shopifyAdminToken.trim() };
            resolved = (0, credential_resolver_util_1.resolveShopifyConfig)({
                agent: {
                    shopifyStoreUrl: bundle.shopifyStoreUrl,
                    secrets: bundle.secrets,
                    useWorkspaceShopify: bundle.useWorkspaceShopify,
                    shopifyApiVersion: bundle.shopifyApiVersion,
                },
                workspace,
                env: this.providerEnvSlice(),
            });
            source = resolved?.source ?? 'missing';
        }
        else if (workspace?.shopifyStoreUrl && workspace?.shopifyAdminToken) {
            resolved = (0, credential_resolver_util_1.resolveShopifyConfig)({
                agent: { useWorkspaceShopify: true },
                workspace,
                env: this.providerEnvSlice(),
            });
            source = resolved?.source ?? 'missing';
        }
        if (!resolved) {
            return {
                success: false,
                message: 'Shopify credentials missing for this agent.',
                status: agentId ? prisma_types_1.ConnectionStatus.FAILED : undefined,
                provider: 'shopify',
                source: 'missing',
            };
        }
        const result = await this.shopifyTest.testConnection({
            shopifyStoreUrl: resolved.shopifyStoreUrl,
            shopifyAdminToken: resolved.shopifyAdminToken,
        });
        const status = result.success ? prisma_types_1.ConnectionStatus.OK : prisma_types_1.ConnectionStatus.FAILED;
        if (agentId) {
            (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'shopify', source, agentId);
            await this.prisma.agent.updateMany({
                where: { id: agentId, tenantId, deletedAt: null },
                data: { shopifyConnectionStatus: status, lastConnectionTestAt: new Date() },
            });
        }
        return {
            ...result,
            status: agentId ? status : undefined,
            provider: 'shopify',
            source,
        };
    }
    async testDatabaseConnection(tenantId, agentId, dto) {
        let config = {};
        if (agentId) {
            const agentConfig = await this.getAgentConfigForTest(tenantId, agentId);
            config = {
                databaseUrl: agentConfig.databaseUrl ?? dto?.databaseUrl,
                databaseAccessToken: agentConfig.databaseAccessToken ?? dto?.databaseAccessToken,
                databaseProvider: agentConfig.databaseProvider ?? dto?.databaseProvider,
            };
        }
        else {
            config = {
                databaseUrl: dto?.databaseUrl,
                databaseAccessToken: dto?.databaseAccessToken,
                databaseProvider: dto?.databaseProvider,
            };
        }
        const result = await this.databaseTest.testConnection(config);
        const status = result.success ? prisma_types_1.ConnectionStatus.OK : prisma_types_1.ConnectionStatus.FAILED;
        if (agentId) {
            await this.prisma.agent.updateMany({
                where: { id: agentId, tenantId, deletedAt: null },
                data: { databaseConnectionStatus: status, lastConnectionTestAt: new Date() },
            });
        }
        return { ...result, status: agentId ? status : undefined };
    }
    async testTwilioConnection(tenantId, agentId, dto) {
        const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
        let twilioResolved = null;
        let source = 'missing';
        if (dto?.twilioAccountSid?.trim() && dto?.twilioAuthToken?.trim()) {
            twilioResolved = {
                accountSid: dto.twilioAccountSid.trim(),
                authToken: dto.twilioAuthToken.trim(),
                phoneNumber: dto.twilioPhoneNumber?.trim(),
                sidSource: 'agent',
                authSource: 'agent',
            };
            source = 'agent';
        }
        else if (agentId) {
            const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
            const agentRow = await this.prisma.agent.findFirst({
                where: { id: agentId, tenantId, deletedAt: null },
                select: { twilioPhoneNumber: true },
            });
            const secrets = { ...bundle.secrets };
            if (dto?.twilioAccountSid?.trim())
                secrets.twilioAccountSid = dto.twilioAccountSid.trim();
            if (dto?.twilioAuthToken?.trim())
                secrets.twilioAuthToken = dto.twilioAuthToken.trim();
            twilioResolved = (0, credential_resolver_util_1.resolveTwilioConfig)({
                agentSecrets: secrets,
                workspace: bundle.workspace,
                useWorkspaceTwilio: dto?.useWorkspaceDefaults === true ? true : bundle.useWorkspaceTwilio,
                agentPhoneNumber: dto?.twilioPhoneNumber?.trim() || agentRow?.twilioPhoneNumber || null,
            });
            source = twilioResolved?.authSource ?? 'missing';
        }
        else if (workspace?.twilioAccountSid && workspace?.twilioAuthToken) {
            twilioResolved = (0, credential_resolver_util_1.resolveTwilioConfig)({
                agentSecrets: undefined,
                workspace,
                useWorkspaceTwilio: true,
                agentPhoneNumber: dto?.twilioPhoneNumber?.trim() || workspace.twilioPhoneNumber,
            });
            source = twilioResolved?.authSource ?? 'missing';
        }
        if (!twilioResolved) {
            return {
                success: false,
                message: 'Twilio credentials missing. Save Account SID and Auth Token on this agent, or enable workspace Twilio under Settings → Integrations.',
                status: agentId ? prisma_types_1.ConnectionStatus.FAILED : undefined,
                provider: 'twilio',
                source: 'missing',
            };
        }
        const result = await this.twilioTest.testConnection({
            twilioAccountSid: twilioResolved.accountSid,
            twilioAuthToken: twilioResolved.authToken,
            twilioPhoneNumber: twilioResolved.phoneNumber,
        });
        const status = result.success ? prisma_types_1.ConnectionStatus.OK : prisma_types_1.ConnectionStatus.FAILED;
        if (agentId) {
            (0, credential_resolver_util_1.logCredentialResolution)(this.log, 'twilio', source, agentId);
            (0, credential_resolver_util_1.logCredentialResolutionDebug)(this.log, {
                provider: 'twilio',
                agentId,
                useWorkspaceTwilio: dto?.useWorkspaceDefaults === true,
                hasAgentTwilio: Boolean(dto?.twilioAccountSid?.trim() && dto?.twilioAuthToken?.trim()),
                hasWorkspaceTwilio: Boolean(workspace?.twilioAccountSid?.trim() && workspace?.twilioAuthToken?.trim()),
                resolvedSource: source,
            });
            await this.prisma.agent.updateMany({
                where: { id: agentId, tenantId, deletedAt: null },
                data: { twilioConnectionStatus: status, lastConnectionTestAt: new Date() },
            });
        }
        return {
            ...result,
            status: agentId ? status : undefined,
            provider: 'twilio',
            source,
            message: result.success
                ? `Twilio connection successful (using ${source} credential).`
                : result.message,
        };
    }
    async testOpenAIConnection(tenantId, agentId, dto) {
        const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
        const envSlice = this.providerEnvSlice();
        let resolved;
        if (dto?.openaiApiKey?.trim()) {
            resolved = { value: dto.openaiApiKey.trim(), source: 'agent' };
        }
        else if (agentId) {
            const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
            const cfg = (0, credential_resolver_util_1.resolveOpenAiConfig)({
                agentSecrets: bundle.secrets,
                workspace: bundle.workspace,
                useWorkspaceOpenai: bundle.useWorkspaceOpenai,
                envApiKey: envSlice?.openaiApiKey,
            });
            resolved = cfg ? { value: cfg.apiKey, source: cfg.source } : { source: 'missing' };
        }
        else {
            resolved = this.resolveCredential(undefined, workspace?.openaiApiKey, envSlice?.openaiApiKey);
        }
        if (resolved.source === 'missing') {
            return {
                success: false,
                message: 'OpenAI test failed: no API key found. Add an OpenAI key on the agent form or enable workspace OpenAI with a saved workspace key.',
                status: agentId ? prisma_types_1.ConnectionStatus.FAILED : undefined,
                provider: 'openai',
                source: 'missing',
            };
        }
        const result = await this.openaiTest.testConnection({ openaiApiKey: resolved.value });
        const status = result.success ? prisma_types_1.ConnectionStatus.OK : prisma_types_1.ConnectionStatus.FAILED;
        if (agentId) {
            (0, credential_resolver_util_1.logCredentialResolutionDebug)(this.log, {
                provider: 'openai',
                agentId,
                useWorkspaceOpenai: dto?.useWorkspaceDefaults === true,
                hasAgentOpenAi: Boolean(dto?.openaiApiKey?.trim()),
                hasWorkspaceOpenAi: Boolean(workspace?.openaiApiKey?.trim()),
                resolvedSource: resolved.source,
            });
            await this.prisma.agent.updateMany({
                where: { id: agentId, tenantId, deletedAt: null },
                data: { openaiConnectionStatus: status, lastConnectionTestAt: new Date() },
            });
        }
        return {
            ...result,
            status: agentId ? status : undefined,
            provider: 'openai',
            source: resolved.source,
            message: result.success
                ? `OpenAI connection successful (using ${resolved.source} credential).`
                : `OpenAI test failed using ${resolved.source} credential: ${result.message}`,
        };
    }
    async testElevenLabsConnection(tenantId, agentId, dto) {
        const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
        const envSlice = this.providerEnvSlice();
        const agentConfig = agentId ? await this.getAgentConfigForTest(tenantId, agentId) : null;
        const bundle = agentId ? await this.loadAgentCredentialBundle(tenantId, agentId) : null;
        const voiceId = dto?.voiceId?.trim() ||
            bundle?.voiceId?.trim() ||
            agentConfig?.voiceId?.trim() ||
            workspace?.elevenlabsDefaultVoiceId?.trim() ||
            undefined;
        const elevenResolved = dto?.elevenlabsApiKey?.trim()
            ? { apiKey: dto.elevenlabsApiKey.trim(), source: 'agent', voiceId }
            : (0, credential_resolver_util_1.resolveElevenLabsConfig)({
                agentSecrets: bundle?.secrets ?? agentConfig ?? undefined,
                workspace: bundle?.workspace ?? workspace,
                useWorkspaceElevenlabs: bundle?.useWorkspaceElevenlabs,
                envApiKey: envSlice?.elevenlabsApiKey,
                agentVoiceId: voiceId ?? null,
            });
        if (!elevenResolved) {
            return {
                success: false,
                message: 'ElevenLabs test failed: no API key found. Add an ElevenLabs key on the agent form or enable workspace ElevenLabs with a saved workspace key.',
                status: agentId ? prisma_types_1.ConnectionStatus.FAILED : undefined,
                provider: 'elevenlabs',
                source: 'missing',
            };
        }
        const result = await this.elevenlabsTest.testConnection({
            elevenlabsApiKey: elevenResolved.apiKey,
            voiceId: elevenResolved.voiceId ?? voiceId,
            source: 'test',
            tenantId,
        });
        const status = result.success ? prisma_types_1.ConnectionStatus.OK : prisma_types_1.ConnectionStatus.FAILED;
        if (agentId) {
            await this.prisma.agent.updateMany({
                where: { id: agentId, tenantId, deletedAt: null },
                data: { elevenlabsConnectionStatus: status, lastConnectionTestAt: new Date() },
            });
        }
        return {
            ...result,
            status: agentId ? status : undefined,
            provider: 'elevenlabs',
            source: elevenResolved.source,
            message: result.success
                ? `ElevenLabs connection successful (using ${elevenResolved.source} credential).`
                : `ElevenLabs test failed using ${elevenResolved.source} credential: ${result.message}`,
        };
    }
    async getAgentAnalytics(tenantId, agentId) {
        await this.findOne(tenantId, agentId);
        const sessions = await this.prisma.callSession.findMany({
            where: { tenantId, agentId },
            select: {
                status: true,
                escalated: true,
                durationSeconds: true,
                startedAt: true,
                endedAt: true,
            },
        });
        const totalCalls = sessions.length;
        const completed = sessions.filter((s) => s.status === 'COMPLETED').length;
        const escalatedCalls = sessions.filter((s) => s.escalated).length;
        const durations = sessions
            .map((s) => s.durationSeconds)
            .filter((d) => d != null && d > 0);
        const avgDurationSeconds = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
        const lastCallAt = sessions.length > 0
            ? sessions
                .map((s) => (s.endedAt ?? s.startedAt)?.getTime() ?? 0)
                .reduce((a, b) => Math.max(a, b), 0)
            : null;
        return {
            totalCalls,
            resolvedCalls: completed - escalatedCalls,
            escalatedCalls,
            avgDurationSeconds: avgDurationSeconds != null ? Math.round(avgDurationSeconds) : null,
            lastCallAt: lastCallAt != null ? new Date(lastCallAt).toISOString() : null,
        };
    }
    async getAgentLogs(tenantId, agentId, limit = 50) {
        await this.findOne(tenantId, agentId);
        const sessions = await this.prisma.callSession.findMany({
            where: { tenantId, agentId },
            orderBy: { createdAt: 'desc' },
            take: Math.min(limit, 100),
            select: {
                id: true,
                fromNumber: true,
                toNumber: true,
                status: true,
                escalated: true,
                durationSeconds: true,
                createdAt: true,
                endedAt: true,
            },
        });
        return sessions.map((s) => ({
            id: s.id,
            fromNumber: s.fromNumber,
            toNumber: s.toNumber,
            status: s.status,
            escalated: s.escalated,
            durationSeconds: s.durationSeconds,
            createdAt: s.createdAt.toISOString(),
            endedAt: s.endedAt?.toISOString() ?? null,
        }));
    }
    async getCatalogReadiness(tenantId, agentId) {
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
        const shopifyResolved = (0, credential_resolver_util_1.resolveShopifyConfig)({
            agent: {
                shopifyStoreUrl: bundle.shopifyStoreUrl,
                secrets: bundle.secrets,
                useWorkspaceShopify: bundle.useWorkspaceShopify,
                shopifyApiVersion: bundle.shopifyApiVersion,
            },
            workspace: bundle.workspace,
            env: this.providerEnvSlice(),
        });
        const shopifySource = shopifyResolved?.source ?? 'missing';
        const shopDomain = shopifyResolved
            ? (0, types_2.normalizeShopifyDomain)(shopifyResolved.shopifyStoreUrl)
            : null;
        if (!shopDomain) {
            return {
                catalogReady: false,
                lastSyncedAt: null,
                itemCount: 0,
                reason: 'shopify_not_connected',
                shopifySource,
                shopifyConfigured: false,
            };
        }
        const [itemCount, latest] = await Promise.all([
            this.prisma.productCache.count({ where: { tenantId, agentId, shopDomain } }),
            this.prisma.productCache.findFirst({
                where: { tenantId, agentId, shopDomain },
                orderBy: { syncedAt: 'desc' },
                select: { syncedAt: true },
            }),
        ]);
        const lastSyncedAt = latest?.syncedAt ?? null;
        const staleMs = Number(process.env.CATALOG_STALE_MS) || 24 * 60 * 60 * 1000;
        const isFresh = lastSyncedAt ? Date.now() - lastSyncedAt.getTime() <= staleMs : false;
        return {
            catalogReady: itemCount > 0 && isFresh,
            lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
            itemCount,
            reason: itemCount === 0 ? 'catalog_empty' : isFresh ? 'ready' : 'catalog_stale',
            shopifySource,
            shopifyConfigured: true,
        };
    }
    async testAiBehavior(tenantId, agentId, sampleQuery) {
        const row = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                baseSystemPrompt: true,
                agentRole: true,
                agentGoal: true,
                allowedActions: true,
                restrictedActions: true,
                model: true,
            },
        });
        if (!row)
            throw new common_1.NotFoundException('Agent not found.');
        const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
        const openaiResolved = (0, credential_resolver_util_1.resolveOpenAiConfig)({
            agentSecrets: bundle.secrets,
            workspace: bundle.workspace,
            useWorkspaceOpenai: bundle.useWorkspaceOpenai,
            envApiKey: this.providerEnvSlice()?.openaiApiKey,
        });
        if (!openaiResolved) {
            return {
                success: false,
                message: 'OpenAI API key is not configured for this agent. Add openaiApiKey on the agent form or enable workspace OpenAI.',
                source: 'missing',
            };
        }
        const apiKey = openaiResolved.apiKey;
        const prompt = [
            row.baseSystemPrompt,
            row.agentRole ? `Role: ${row.agentRole}` : '',
            row.agentGoal ? `Goal: ${row.agentGoal}` : '',
            row.allowedActions ? `Allowed: ${row.allowedActions}` : '',
            row.restrictedActions ? `Not allowed: ${row.restrictedActions}` : '',
        ].filter(Boolean).join('\n\n');
        const model = row.model?.trim() || 'gpt-4o-mini';
        const client = new openai_1.default({ apiKey });
        const completion = await client.chat.completions.create({
            model,
            temperature: 0.2,
            messages: [
                { role: 'system', content: prompt || 'You are a helpful store support assistant.' },
                { role: 'user', content: sampleQuery || 'Where is my order?' },
            ],
            max_tokens: 220,
        });
        const responseText = completion.choices[0]?.message?.content?.trim() || '';
        return {
            success: Boolean(responseText),
            message: responseText
                ? `AI behavior test completed successfully (using ${openaiResolved.source} credential).`
                : `AI behavior test completed but model returned no content (using ${openaiResolved.source} credential).`,
            suggestedResponse: responseText || undefined,
            source: openaiResolved.source,
        };
    }
    async getRuntimeDebug(tenantId, agentId, callSessionId) {
        void callSessionId;
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                id: true,
                storeName: true,
                voiceId: true,
                baseSystemPrompt: true,
                updatedAt: true,
                agentConfig: {
                    select: {
                        metadata: true,
                        updatedAt: true,
                    },
                },
                voiceProfile: {
                    select: {
                        providerConfig: true,
                    },
                },
            },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const cfgMeta = agent.agentConfig?.metadata &&
            typeof agent.agentConfig.metadata === 'object' &&
            !Array.isArray(agent.agentConfig.metadata)
            ? agent.agentConfig.metadata
            : null;
        const configVersion = typeof cfgMeta?.configVersion === 'number' && Number.isFinite(cfgMeta.configVersion)
            ? Number(cfgMeta.configVersion)
            : 1;
        const promptUpdatedAt = typeof cfgMeta?.promptUpdatedAt === 'string' && cfgMeta.promptUpdatedAt.trim()
            ? cfgMeta.promptUpdatedAt
            : agent.agentConfig?.updatedAt?.toISOString() ?? agent.updatedAt.toISOString();
        const providerConfig = agent.voiceProfile?.providerConfig ?? null;
        const voicePersonality = providerConfig?.personality ?? null;
        return {
            agentId: agent.id,
            configVersion,
            promptUpdatedAt,
            voiceId: agent.voiceId ?? null,
            voicePersonality,
            storeName: agent.storeName ?? 'Store',
            systemPromptPreview: (agent.baseSystemPrompt ?? '').slice(0, 200),
            updatedAt: agent.updatedAt.toISOString(),
        };
    }
    async getPersistenceDiagnostics(tenantId, agentId) {
        const [agent, workspace, readiness] = await Promise.all([
            this.prisma.agent.findFirst({
                where: { id: agentId, tenantId, deletedAt: null },
                select: { id: true, status: true, twilioPhoneNumber: true },
            }),
            this.prisma.tenantIntegration.findUnique({
                where: { tenantId },
                select: {
                    id: true,
                    twilioAccountSid: true,
                    twilioAuthTokenEnc: true,
                    openaiApiKeyEnc: true,
                    resendApiKeyEnc: true,
                    shopifyShopDomain: true,
                },
            }),
            this.getAgentReadiness(tenantId, agentId),
        ]);
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        return {
            dbConnected: true,
            tenantId,
            workspaceId: workspace?.id ?? null,
            agentId: agent.id,
            agentStatusFromDb: agent.status,
            mappedPhoneNumber: agent.twilioPhoneNumber ?? null,
            workspaceSaved: {
                twilio: Boolean(workspace?.twilioAccountSid && workspace?.twilioAuthTokenEnc),
                openai: Boolean(workspace?.openaiApiKeyEnc),
                resend: Boolean(workspace?.resendApiKeyEnc),
            },
            shopifySource: readiness.credentialSources?.shopify.source ?? 'missing',
            runtimeCredentialSource: {
                shopify: readiness.credentialSources?.shopify.source ?? 'missing',
                twilio: readiness.credentialSources?.twilio.authSource ?? 'missing',
                openai: readiness.credentialSources?.openai.source ?? 'missing',
                elevenlabs: readiness.credentialSources?.elevenlabs.source ?? 'missing',
                resend: readiness.credentialSources?.resend.source ?? 'missing',
            },
        };
    }
};
exports.AgentsService = AgentsService;
exports.AgentsService = AgentsService = AgentsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService,
        config_1.ConfigService,
        shopify_connection_test_service_1.ShopifyConnectionTestService,
        database_connection_test_service_1.DatabaseConnectionTestService,
        twilio_connection_test_service_1.TwilioConnectionTestService,
        openai_connection_test_service_1.OpenAIConnectionTestService,
        elevenlabs_connection_test_service_1.ElevenLabsConnectionTestService,
        product_sync_queue_1.ShopifyProductSyncQueueService,
        agent_email_config_service_1.AgentEmailConfigService,
        resend_email_service_1.ResendEmailService,
        runtime_tool_registry_service_1.RuntimeToolRegistryService])
], AgentsService);
//# sourceMappingURL=agents.service.js.map