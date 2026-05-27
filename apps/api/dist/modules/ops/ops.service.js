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
exports.OpsService = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../database/prisma.service");
const encryption_service_1 = require("../../common/encryption.service");
const public_webhook_base_url_1 = require("../../common/public-webhook-base-url");
const calls_service_1 = require("../calls/calls.service");
const session_context_service_1 = require("../calls/runtime/session-context.service");
const tool_orchestrator_service_1 = require("../calls/runtime/tool-orchestrator.service");
const product_sync_1 = require("../integrations/shopify/product-sync");
const resend_email_service_1 = require("../integrations/email/resend-email.service");
const types_1 = require("@bookstore-voice-agents/types");
const payment_email_idempotency_1 = require("../../common/payment-email-idempotency");
const openai_connection_test_service_1 = require("../agents/connection-test/openai-connection-test.service");
const twilio_connection_test_service_1 = require("../agents/connection-test/twilio-connection-test.service");
let OpsService = class OpsService {
    constructor(prisma, config, encryption, callsService, sessionContext, toolOrchestrator, shopifySync, resendEmail, openaiTest, twilioTest) {
        this.prisma = prisma;
        this.config = config;
        this.encryption = encryption;
        this.callsService = callsService;
        this.sessionContext = sessionContext;
        this.toolOrchestrator = toolOrchestrator;
        this.shopifySync = shopifySync;
        this.resendEmail = resendEmail;
        this.openaiTest = openaiTest;
        this.twilioTest = twilioTest;
    }
    decryptSecretsBlob(secretsEnc) {
        if (!secretsEnc || !this.encryption.isAvailable())
            return {};
        const decrypted = this.encryption.decryptFromStorage(secretsEnc);
        if (!decrypted)
            return {};
        try {
            const parsed = JSON.parse(decrypted);
            const out = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'string' && v.trim())
                    out[k] = v.trim();
            }
            return out;
        }
        catch {
            return {};
        }
    }
    normalizeUrlNoSlash(url) {
        return (url ?? '').trim().replace(/\/+$/, '');
    }
    getAgentsOverview(tenantId) {
        return this.prisma.agent.findMany({
            where: { tenantId, deletedAt: null },
            orderBy: { updatedAt: 'desc' },
            select: {
                id: true,
                name: true,
                status: true,
                updatedAt: true,
                shopifyConnectionStatus: true,
                twilioConnectionStatus: true,
                openaiConnectionStatus: true,
                voiceProfile: true,
            },
        });
    }
    getCalls(tenantId) {
        return this.prisma.callSession.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            take: 200,
            include: { agent: { select: { id: true, name: true } } },
        });
    }
    getTranscripts(tenantId, callSessionId) {
        return this.prisma.callTranscript.findMany({
            where: { callSession: { tenantId, id: callSessionId } },
            orderBy: { sequenceNumber: 'asc' },
        });
    }
    getCheckoutLinks(tenantId) {
        return this.prisma.checkoutLink.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            include: { agent: { select: { id: true, name: true } } },
            take: 200,
        });
    }
    getLeads(tenantId) {
        return this.prisma.leadCapture.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            include: { agent: { select: { id: true, name: true } } },
            take: 200,
        });
    }
    getEmailEvents(tenantId) {
        return this.prisma.emailEvent.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            include: { agent: { select: { id: true, name: true } } },
            take: 200,
        });
    }
    getPayments(tenantId) {
        return this.prisma.paymentRecord.findMany({
            where: { tenantId },
            orderBy: { updatedAt: 'desc' },
            include: {
                agent: { select: { id: true, name: true } },
                checkoutLink: { select: { id: true, checkoutUrl: true, callSessionId: true } },
            },
            take: 200,
        });
    }
    async simulateToolCall(tenantId, agentId, input) {
        this.assertDevOpsEndpointsAllowed();
        const toolName = input.toolName?.trim();
        if (!toolName)
            throw new common_1.BadRequestException('toolName is required.');
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { id: true, storeId: true, twilioPhoneNumber: true },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        let callSessionId = input.callSessionId?.trim() || '';
        if (!callSessionId) {
            const now = Date.now();
            const session = await this.callsService.createSession({
                tenantId,
                agentId: agent.id,
                storeId: agent.storeId ?? null,
                twilioCallSid: `dev-sim-${now}-${Math.floor(Math.random() * 10000)}`,
                fromNumber: '+15550000001',
                toNumber: agent.twilioPhoneNumber ?? '+15550000002',
                direction: 'inbound',
            });
            callSessionId = session.id;
        }
        const ctx = await this.sessionContext.load(callSessionId);
        if (!ctx || ctx.tenantId !== tenantId || ctx.agentId !== agent.id) {
            throw new common_1.BadRequestException('callSessionId does not match tenant/agent context.');
        }
        const result = await this.toolOrchestrator.execute(ctx, toolName, input.args ?? {}, callSessionId, `dev-sim-${Date.now()}`);
        return { ok: true, callSessionId, toolName, result };
    }
    async syncProductsManual(tenantId, agentId) {
        this.assertDevOpsEndpointsAllowed();
        await this.prisma.agent.findFirstOrThrow({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { id: true },
        });
        const result = await this.shopifySync.syncProducts(tenantId, agentId);
        return { ok: true, agentId, ...result };
    }
    async sendDevelopmentTestEmail(tenantId, agentId, body) {
        this.assertDevOpsEndpointsAllowed();
        const toEmail = body.toEmail?.trim().toLowerCase();
        if (!toEmail)
            throw new common_1.BadRequestException('toEmail is required.');
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            include: { agentConfig: true },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const customCheckout = body.checkoutUrl?.trim();
        const fallback = process.env.DEV_TEST_CHECKOUT_URL?.trim();
        const resolvedUrl = customCheckout || fallback;
        if (!resolvedUrl) {
            throw new common_1.BadRequestException('Set DEV_TEST_CHECKOUT_URL in the API environment, or pass checkoutUrl (HTTPS, matching the agent store host).');
        }
        if (customCheckout) {
            this.assertHttpsCheckoutUrlMatchesAgentShop(resolvedUrl, agent.shopifyStoreUrl);
        }
        const checkoutFingerprint = (0, node_crypto_1.createHash)('sha256')
            .update(`ops_dev_test_email|${tenantId}|${agentId}|${toEmail}|${resolvedUrl}`)
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
                    itemsJson: [{ title: 'Developer test item', quantity: 1 }],
                    metadata: {
                        source: 'dev_test_email_route',
                        reusedFromFingerprint: existing ? true : false,
                    },
                },
            }));
        const email = await this.resendEmail.sendPaymentEmail({
            tenantId,
            agentId,
            checkoutLinkId: checkout.id,
            idempotencyKey: (0, payment_email_idempotency_1.paymentEmailIdempotencyKey)({
                tenantId,
                agentId,
                checkoutLinkId: checkout.id,
                recipientEmail: toEmail,
                purpose: 'ops_dev_test_email',
            }),
            to: toEmail,
            businessName: agent.agentConfig?.businessName?.trim() || agent.name,
            supportEmail: agent.agentConfig?.supportEmail,
            supportPhone: agent.agentConfig?.supportPhone,
            checkoutUrl: checkout.checkoutUrl,
            items: [{ title: 'Developer test item', quantity: 1 }],
        });
        if (!email.deduplicated) {
            await this.prisma.checkoutLink.updateMany({
                where: { id: checkout.id, tenantId },
                data: { status: 'SENT', sentAt: new Date() },
            });
        }
        return {
            ok: true,
            checkoutLinkId: checkout.id,
            emailEventId: email.emailEventId,
            reusedCheckout: existing ? true : false,
            deduplicatedEmail: email.deduplicated === true,
        };
    }
    async simulateBuyingFlow(tenantId, agentId, body) {
        this.assertDevOpsEndpointsAllowed();
        const productQuery = body.query?.trim() || 'demo';
        const customerEmail = body.customerEmail?.trim().toLowerCase() ||
            process.env.DEV_TEST_CUSTOMER_EMAIL?.trim().toLowerCase() ||
            'demo.customer@example.com';
        const sendEmail = body.sendEmail === true;
        const callSessionId = body.callSessionId?.trim();
        const steps = [];
        const search = (await this.simulateToolCall(tenantId, agentId, {
            callSessionId,
            toolName: 'searchProducts',
            args: { query: productQuery, limit: 5 },
        }));
        steps.push({ step: 'searchProducts', output: search });
        if (!search.result.ok)
            return { ok: false, reason: 'search failed', steps };
        const searchData = this.readDataObject(search.result);
        const results = Array.isArray(searchData.results)
            ? searchData.results
            : [];
        const first = results[0];
        if (!first)
            return { ok: false, reason: 'no products found', steps };
        const productId = typeof first.id === 'string' ? first.id : '';
        const variants = Array.isArray(first.variants) ? first.variants : [];
        const firstVariantId = typeof variants[0]?.id === 'string' ? variants[0].id : '';
        const details = (await this.simulateToolCall(tenantId, agentId, {
            callSessionId: search.callSessionId,
            toolName: 'getProductDetails',
            args: { productId, variantId: firstVariantId || undefined },
        }));
        steps.push({ step: 'getProductDetails', output: details });
        if (!details.result.ok)
            return { ok: false, reason: 'details failed', steps };
        const checkoutArgs = {
            email: customerEmail,
            items: [{ variantId: firstVariantId || productId, quantity: 1 }],
            forceNewCheckout: false,
        };
        if (body.checkoutMode)
            checkoutArgs.mode = body.checkoutMode;
        const checkout = (await this.simulateToolCall(tenantId, agentId, {
            callSessionId: search.callSessionId,
            toolName: 'createCheckoutLink',
            args: checkoutArgs,
        }));
        steps.push({ step: 'createCheckoutLink', output: checkout });
        if (!checkout.result.ok || !sendEmail) {
            return { ok: checkout.result.ok, callSessionId: search.callSessionId, emailSent: false, steps };
        }
        const checkoutData = this.readDataObject(checkout.result);
        const checkoutLinkId = typeof checkoutData.checkoutLinkId === 'string' ? checkoutData.checkoutLinkId : '';
        if (!checkoutLinkId)
            return { ok: false, reason: 'checkoutLinkId missing', steps };
        const email = (await this.simulateToolCall(tenantId, agentId, {
            callSessionId: search.callSessionId,
            toolName: 'sendPaymentEmail',
            args: { email: customerEmail, checkoutLinkId },
        }));
        steps.push({ step: 'sendPaymentEmail', output: email });
        return {
            ok: email.result.ok,
            callSessionId: search.callSessionId,
            emailSent: true,
            steps,
        };
    }
    async fullReadinessSmoke(tenantId, agentId, body) {
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                id: true,
                name: true,
                enabledTools: true,
                shopifyStoreUrl: true,
                twilioPhoneNumber: true,
                secretsEnc: true,
                agentConfig: {
                    select: {
                        askEmailBeforePaymentLink: true,
                        checkoutMode: true,
                    },
                },
            },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const tenantIntegration = await this.prisma.tenantIntegration.findUnique({
            where: { tenantId },
            select: {
                twilioAccountSid: true,
                twilioAuthTokenEnc: true,
                twilioPhoneNumber: true,
                openaiApiKeyEnc: true,
                resendApiKeyEnc: true,
                resendFromEmail: true,
                emailLastTestOk: true,
            },
        });
        const secrets = this.decryptSecretsBlob(agent.secretsEnc);
        const workspaceTwilioAuth = tenantIntegration?.twilioAuthTokenEnc
            ? this.encryption.decryptFromStorage(tenantIntegration.twilioAuthTokenEnc)
            : null;
        const workspaceOpenAi = tenantIntegration?.openaiApiKeyEnc
            ? this.encryption.decryptFromStorage(tenantIntegration.openaiApiKeyEnc)
            : null;
        const twilioSid = secrets.twilioAccountSid || tenantIntegration?.twilioAccountSid?.trim() || '';
        const twilioAuth = secrets.twilioAuthToken || workspaceTwilioAuth?.trim() || '';
        const twilioPhone = agent.twilioPhoneNumber?.trim() || tenantIntegration?.twilioPhoneNumber?.trim() || '';
        const openaiApiKey = secrets.openaiApiKey ||
            workspaceOpenAi?.trim() ||
            this.config.get('OPENAI_API_KEY')?.trim() ||
            '';
        const expectedBase = (0, public_webhook_base_url_1.normalizePublicWebhookBaseUrl)(this.config.get('PUBLIC_WEBHOOK_BASE_URL'));
        const expectedInbound = `${expectedBase}/api/twilio/voice/inbound`;
        const expectedStatus = `${expectedBase}/api/twilio/voice/status`;
        const openaiResult = openaiApiKey
            ? await this.openaiTest.testConnection({ openaiApiKey })
            : { success: false, message: 'OpenAI key is missing at agent/workspace/env level.' };
        const twilioPhoneConfig = twilioSid && twilioAuth && twilioPhone
            ? await this.twilioTest.getIncomingPhoneNumberConfig({
                twilioAccountSid: twilioSid,
                twilioAuthToken: twilioAuth,
                twilioPhoneNumber: twilioPhone,
            })
            : null;
        const twilioWebhookOk = Boolean(twilioPhoneConfig) &&
            this.normalizeUrlNoSlash(twilioPhoneConfig?.voiceUrl) === this.normalizeUrlNoSlash(expectedInbound) &&
            this.normalizeUrlNoSlash(twilioPhoneConfig?.statusCallback) ===
                this.normalizeUrlNoSlash(expectedStatus) &&
            (twilioPhoneConfig?.voiceMethod ?? '').toUpperCase() === 'POST' &&
            (twilioPhoneConfig?.statusCallbackMethod ?? '').toUpperCase() === 'POST';
        const requiredTools = [
            'searchProducts',
            'getProductDetails',
            'createCheckoutLink',
            'sendPaymentEmail',
        ];
        const enabledTools = Array.isArray(agent.enabledTools) ? agent.enabledTools : [];
        const toolsCoverage = enabledTools.length === 0
            ? { mode: 'all_enabled_by_default', missingTools: [] }
            : {
                mode: 'explicit_tool_allowlist',
                missingTools: requiredTools.filter((tool) => !enabledTools.includes(tool)),
            };
        const shopDomain = (0, types_1.normalizeShopifyDomain)(agent.shopifyStoreUrl);
        const [catalogItemCount, latestSynced] = shopDomain
            ? await Promise.all([
                this.prisma.productCache.count({ where: { tenantId, agentId, shopDomain } }),
                this.prisma.productCache.findFirst({
                    where: { tenantId, agentId, shopDomain },
                    orderBy: { syncedAt: 'desc' },
                    select: { syncedAt: true },
                }),
            ])
            : [0, null];
        const staleMs = Number(process.env.CATALOG_STALE_MS) || 24 * 60 * 60 * 1000;
        const catalogReady = catalogItemCount > 0 &&
            Boolean(latestSynced?.syncedAt) &&
            Date.now() - new Date(latestSynced.syncedAt).getTime() <= staleMs;
        const emailReady = Boolean(tenantIntegration?.resendApiKeyEnc &&
            tenantIntegration?.resendFromEmail?.trim() &&
            tenantIntegration?.emailLastTestOk);
        const checks = [
            { key: 'openai_connected', pass: openaiResult.success, details: openaiResult.message },
            {
                key: 'twilio_number_credentials_present',
                pass: Boolean(twilioSid && twilioAuth && twilioPhone),
                details: twilioSid && twilioAuth && twilioPhone ? 'Twilio SID/auth/phone resolved.' : 'Twilio SID/auth/phone missing.',
            },
            {
                key: 'twilio_webhook_inbound_post',
                pass: twilioWebhookOk,
                details: twilioPhoneConfig
                    ? `Observed voiceUrl=${twilioPhoneConfig.voiceUrl ?? 'null'} method=${twilioPhoneConfig.voiceMethod ?? 'null'}`
                    : 'Could not resolve Twilio phone config from API.',
            },
            {
                key: 'catalog_synced',
                pass: catalogReady,
                details: `shopDomain=${shopDomain ?? 'none'} items=${catalogItemCount} latestSync=${latestSynced?.syncedAt?.toISOString() ?? 'none'}`,
            },
            {
                key: 'required_shopify_checkout_tools_enabled',
                pass: toolsCoverage.missingTools.length === 0,
                details: toolsCoverage.missingTools.length === 0
                    ? `mode=${toolsCoverage.mode}`
                    : `Missing tools: ${toolsCoverage.missingTools.join(', ')}`,
            },
            {
                key: 'ask_email_before_payment_link',
                pass: agent.agentConfig?.askEmailBeforePaymentLink !== false,
                details: `askEmailBeforePaymentLink=${String(agent.agentConfig?.askEmailBeforePaymentLink ?? true)}`,
            },
            {
                key: 'payment_email_provider_ready',
                pass: emailReady,
                details: emailReady
                    ? `from=${tenantIntegration?.resendFromEmail ?? ''}`
                    : 'Resend not fully configured/tested at workspace level.',
            },
        ];
        let flowSimulation = null;
        if (body.runFlowSimulation === true) {
            try {
                flowSimulation = await this.simulateBuyingFlow(tenantId, agentId, {
                    query: body.query,
                    customerEmail: body.customerEmail,
                    sendEmail: body.sendEmail,
                    checkoutMode: body.checkoutMode,
                    callSessionId: body.callSessionId,
                });
            }
            catch (err) {
                if (err instanceof common_1.ForbiddenException || err instanceof common_1.ConflictException) {
                    flowSimulation = {
                        ok: false,
                        reason: 'flow_simulation_blocked',
                        message: err.message,
                    };
                }
                else {
                    flowSimulation = {
                        ok: false,
                        reason: 'flow_simulation_failed',
                        message: err instanceof Error ? err.message : 'unknown_error',
                    };
                }
            }
        }
        const failedChecks = checks.filter((check) => !check.pass);
        return {
            ok: failedChecks.length === 0,
            agentId: agent.id,
            agentName: agent.name,
            summary: {
                passed: checks.length - failedChecks.length,
                failed: failedChecks.length,
            },
            expectedTwilioWebhook: {
                inbound: expectedInbound,
                status: expectedStatus,
                method: 'POST',
            },
            observedTwilioWebhook: twilioPhoneConfig
                ? {
                    voiceUrl: twilioPhoneConfig.voiceUrl,
                    voiceMethod: twilioPhoneConfig.voiceMethod,
                    statusCallback: twilioPhoneConfig.statusCallback,
                    statusCallbackMethod: twilioPhoneConfig.statusCallbackMethod,
                }
                : null,
            checks,
            flowSimulation,
        };
    }
    assertDevOpsEndpointsAllowed() {
        if (process.env.NODE_ENV === 'production' && process.env.ENABLE_DEV_OPS_ENDPOINTS !== 'true') {
            throw new common_1.ForbiddenException('Development ops endpoints are disabled in production. Set ENABLE_DEV_OPS_ENDPOINTS=true only for controlled staging.');
        }
    }
    normalizeShopHost(raw) {
        return raw
            .replace(/^https?:\/\//i, '')
            .replace(/\/$/, '')
            .split('/')[0]
            .toLowerCase();
    }
    assertHttpsCheckoutUrlMatchesAgentShop(checkoutUrl, shopifyStoreUrl) {
        let url;
        try {
            url = new URL(checkoutUrl);
        }
        catch {
            throw new common_1.BadRequestException('Invalid checkout URL.');
        }
        if (url.protocol !== 'https:') {
            throw new common_1.BadRequestException('Checkout URL must use HTTPS.');
        }
        const shop = shopifyStoreUrl?.trim();
        if (!shop) {
            throw new common_1.BadRequestException('Configure Shopify store URL on the agent before using a custom checkout URL.');
        }
        const allowed = this.normalizeShopHost(shop);
        const host = url.hostname.toLowerCase();
        if (host !== allowed && !host.endsWith('.' + allowed)) {
            throw new common_1.BadRequestException("Checkout URL host must match this agent's Shopify store domain.");
        }
    }
    readDataObject(result) {
        return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
            ? result.data
            : {};
    }
};
exports.OpsService = OpsService;
exports.OpsService = OpsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        config_1.ConfigService,
        encryption_service_1.EncryptionService,
        calls_service_1.CallsService,
        session_context_service_1.SessionContextService,
        tool_orchestrator_service_1.ToolOrchestratorService,
        product_sync_1.ShopifyProductSyncService,
        resend_email_service_1.ResendEmailService,
        openai_connection_test_service_1.OpenAIConnectionTestService,
        twilio_connection_test_service_1.TwilioConnectionTestService])
], OpsService);
//# sourceMappingURL=ops.service.js.map