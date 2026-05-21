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
exports.ShopifyService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../database/prisma.service");
const encryption_service_1 = require("../../../common/encryption.service");
const public_webhook_base_url_1 = require("../../../common/public-webhook-base-url");
const client_1 = require("@prisma/client");
const webhook_reconciliation_util_1 = require("./webhook-reconciliation.util");
const SHOPIFY_ADMIN_API_VERSION = '2024-10';
const WEBHOOK_TOPICS = [
    'orders/create',
    'carts/create',
    'orders/updated',
    'products/create',
    'products/update',
    'customers/create',
    'customers/update',
];
let ShopifyService = class ShopifyService {
    constructor(config, prisma, encryption) {
        this.config = config;
        this.prisma = prisma;
        this.encryption = encryption;
    }
    stateSecret() {
        return (this.config.get('JWT_SECRET')?.trim() ||
            this.config.get('SHOPIFY_API_SECRET')?.trim() ||
            'dev-shopify-state-secret');
    }
    appKey() {
        const key = this.config.get('SHOPIFY_API_KEY')?.trim();
        if (!key)
            throw new common_1.BadRequestException('SHOPIFY_API_KEY is not configured.');
        return key;
    }
    appSecret() {
        const secret = this.config.get('SHOPIFY_API_SECRET')?.trim();
        if (!secret)
            throw new common_1.BadRequestException('SHOPIFY_API_SECRET is not configured.');
        const lower = secret.toLowerCase();
        if (lower.startsWith('shpat_')) {
            throw new common_1.BadRequestException('SHOPIFY_API_SECRET is set to an Admin API access token (shpat_). Use the app API secret key from Shopify (OAuth client secret), not the admin token.');
        }
        if (lower.startsWith('shpss_')) {
            throw new common_1.BadRequestException('SHOPIFY_API_SECRET looks like a Storefront access token (shpss_). Use the app API secret key from Shopify Admin → your app → API credentials → API secret key (reveal).');
        }
        return secret;
    }
    callbackUrl() {
        const base = (0, public_webhook_base_url_1.normalizePublicWebhookBaseUrl)(this.config.get('PUBLIC_WEBHOOK_BASE_URL'));
        if (!base) {
            throw new common_1.BadRequestException('PUBLIC_WEBHOOK_BASE_URL must be configured for Shopify OAuth callback.');
        }
        return `${base}/api/integrations/shopify/oauth/callback`;
    }
    webhookAddress() {
        const base = (0, public_webhook_base_url_1.normalizePublicWebhookBaseUrl)(this.config.get('PUBLIC_WEBHOOK_BASE_URL'));
        if (!base) {
            throw new common_1.BadRequestException('PUBLIC_WEBHOOK_BASE_URL must be configured for Shopify webhook registration.');
        }
        return `${base}/api/integrations/shopify/webhooks`;
    }
    normalizeShopDomain(input) {
        const raw = input.trim().toLowerCase();
        const withoutProtocol = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!withoutProtocol.endsWith('.myshopify.com')) {
            throw new common_1.BadRequestException('Use a valid Shopify domain (e.g. your-store.myshopify.com).');
        }
        return withoutProtocol;
    }
    shopUrlCandidates(shopDomain) {
        const d = this.normalizeShopDomain(shopDomain);
        return [
            d,
            `https://${d}`,
            `https://${d}/`,
            `http://${d}`,
            `http://${d}/`,
        ];
    }
    encodeState(payload) {
        const json = JSON.stringify(payload);
        const b64 = Buffer.from(json, 'utf8').toString('base64url');
        const sig = (0, crypto_1.createHmac)('sha256', this.stateSecret()).update(b64).digest('base64url');
        return `${b64}.${sig}`;
    }
    decodeState(state) {
        const [b64, sig] = state.split('.');
        if (!b64 || !sig)
            throw new common_1.UnauthorizedException('Invalid OAuth state.');
        const expected = (0, crypto_1.createHmac)('sha256', this.stateSecret()).update(b64).digest('base64url');
        if (!(0, crypto_1.timingSafeEqual)(Buffer.from(sig), Buffer.from(expected))) {
            throw new common_1.UnauthorizedException('Invalid OAuth state signature.');
        }
        const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
        if (!payload?.tenantId || !payload?.agentId || !payload?.issuedAt) {
            throw new common_1.UnauthorizedException('Invalid OAuth state payload.');
        }
        if (Date.now() - payload.issuedAt > 10 * 60 * 1000) {
            throw new common_1.UnauthorizedException('OAuth state expired. Please try connecting again.');
        }
        return payload;
    }
    verifyOAuthHmac(query) {
        const hmac = query.get('hmac') ?? '';
        if (!hmac)
            return false;
        const msg = [...query.entries()]
            .filter(([k]) => k !== 'hmac' && k !== 'signature')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('&');
        const digest = (0, crypto_1.createHmac)('sha256', this.appSecret()).update(msg).digest('hex');
        try {
            return (0, crypto_1.timingSafeEqual)(Buffer.from(digest), Buffer.from(hmac));
        }
        catch {
            return false;
        }
    }
    buildInstallUrl(tenantId, agentId, shop) {
        const shopDomain = this.normalizeShopDomain(shop);
        const scopes = this.config.get('SHOPIFY_SCOPES')?.trim() ||
            'read_products,read_orders,read_customers';
        const state = this.encodeState({ tenantId, agentId, issuedAt: Date.now() });
        const params = new URLSearchParams({
            client_id: this.appKey(),
            scope: scopes,
            redirect_uri: this.callbackUrl(),
            state,
        });
        return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
    }
    async fetchShopifyRest(shopDomain, accessToken, path, init) {
        const url = `https://${shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/${path.replace(/^\//, '')}`;
        const res = await fetch(url, {
            ...init,
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json',
                ...(init?.headers ?? {}),
            },
        });
        const text = await res.text();
        if (!res.ok) {
            throw new common_1.BadRequestException(`Shopify API ${res.status}: ${text.slice(0, 200)}`);
        }
        return (text ? JSON.parse(text) : {});
    }
    async listWebhooks(shopDomain, accessToken) {
        const data = await this.fetchShopifyRest(shopDomain, accessToken, 'webhooks.json', { method: 'GET' });
        return data.webhooks ?? [];
    }
    async ensureWebhooksRegistered(shopDomain, accessToken) {
        const existing = await this.listWebhooks(shopDomain, accessToken);
        const address = this.webhookAddress();
        const existingSet = new Set(existing.map((w) => `${w.topic}|${w.address}`));
        const created = [];
        for (const topic of WEBHOOK_TOPICS) {
            const key = `${topic}|${address}`;
            if (existingSet.has(key))
                continue;
            await this.fetchShopifyRest(shopDomain, accessToken, 'webhooks.json', {
                method: 'POST',
                body: JSON.stringify({
                    webhook: {
                        topic,
                        address,
                        format: 'json',
                    },
                }),
            });
            created.push(topic);
        }
        return created;
    }
    async handleOAuthCallback(query) {
        if (!this.verifyOAuthHmac(query)) {
            throw new common_1.UnauthorizedException('Invalid Shopify OAuth callback signature.');
        }
        const shop = this.normalizeShopDomain(query.get('shop') ?? '');
        const code = query.get('code')?.trim();
        const state = query.get('state')?.trim();
        if (!code || !state)
            throw new common_1.BadRequestException('Missing Shopify OAuth callback parameters.');
        const statePayload = this.decodeState(state);
        const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: this.appKey(),
                client_secret: this.appSecret(),
                code,
            }),
        });
        const tokenJson = (await tokenRes.json().catch(() => ({})));
        if (!tokenRes.ok || !tokenJson.access_token) {
            throw new common_1.BadRequestException('Failed to exchange Shopify OAuth code for access token.');
        }
        const token = tokenJson.access_token.trim();
        const accessTokenEnc = this.encryption.encryptToStorage(token);
        if (!accessTokenEnc)
            throw new common_1.BadRequestException('Encryption key is not configured; cannot store Shopify token.');
        const storeUrl = `https://${shop}`;
        const existing = await this.prisma.agent.findFirst({
            where: { id: statePayload.agentId, tenantId: statePayload.tenantId, deletedAt: null },
            select: { id: true, secretsEnc: true },
        });
        if (!existing)
            throw new common_1.BadRequestException('Agent not found for this OAuth session.');
        let mergedSecrets = {
            shopifyAdminToken: token,
            shopifyApiKey: this.appKey(),
            shopifyApiSecret: this.appSecret(),
        };
        if (existing.secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(existing.secretsEnc);
            if (dec) {
                try {
                    mergedSecrets = { ...JSON.parse(dec), ...mergedSecrets };
                }
                catch {
                }
            }
        }
        const mergedEnc = this.encryption.encryptToStorage(JSON.stringify(mergedSecrets));
        if (!mergedEnc)
            throw new common_1.BadRequestException('Failed to encrypt Shopify credentials for storage.');
        await this.prisma.agent.updateMany({
            where: { id: statePayload.agentId, tenantId: statePayload.tenantId, deletedAt: null },
            data: {
                shopifyStoreUrl: storeUrl,
                shopifyConnectionStatus: client_1.ConnectionStatus.OK,
                lastConnectionTestAt: new Date(),
                secretsEnc: mergedEnc,
            },
        });
        const maybeStore = await this.prisma.store.findFirst({
            where: { tenantId: statePayload.tenantId, slug: shop.replace('.myshopify.com', ''), deletedAt: null },
            select: { id: true },
        });
        if (maybeStore) {
            await this.prisma.shopifyConnection.upsert({
                where: { storeId: maybeStore.id },
                create: {
                    tenantId: statePayload.tenantId,
                    storeId: maybeStore.id,
                    shopDomain: shop,
                    accessTokenEnc,
                    scopes: tokenJson.scope ?? null,
                    apiVersion: SHOPIFY_ADMIN_API_VERSION,
                    connectedAt: new Date(),
                },
                update: {
                    shopDomain: shop,
                    accessTokenEnc,
                    scopes: tokenJson.scope ?? null,
                    apiVersion: SHOPIFY_ADMIN_API_VERSION,
                    connectedAt: new Date(),
                    lastSyncedAt: new Date(),
                },
            });
        }
        const createdWebhooks = await this.ensureWebhooksRegistered(shop, token).catch(() => []);
        await this.prisma.auditLog.create({
            data: {
                tenantId: statePayload.tenantId,
                action: 'SHOPIFY_OAUTH_CONNECTED',
                entityType: 'SHOPIFY_CONNECTION',
                entityId: shop,
                metadata: {
                    shop,
                    agentId: statePayload.agentId,
                    webhookAddress: this.webhookAddress(),
                    createdWebhooks,
                    connectedAt: new Date().toISOString(),
                },
            },
        });
        const appUrl = this.config.get('CORS_ORIGIN')?.split(',')[0]?.trim() || 'http://localhost:3000';
        return {
            redirectUrl: `${appUrl.replace(/\/$/, '')}/dashboard/agents/${statePayload.agentId}?shopify=connected`,
        };
    }
    verifyWebhookSignature(rawBody, signatureB64) {
        const secret = this.appSecret();
        if (!signatureB64)
            return false;
        const digest = (0, crypto_1.createHmac)('sha256', secret).update(rawBody).digest('base64');
        try {
            return (0, crypto_1.timingSafeEqual)(Buffer.from(digest), Buffer.from(signatureB64));
        }
        catch {
            return false;
        }
    }
    async getConnectionStatus(tenantId, agentId) {
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                id: true,
                name: true,
                shopifyStoreUrl: true,
                shopifyConnectionStatus: true,
                lastConnectionTestAt: true,
                secretsEnc: true,
            },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        let token = null;
        if (agent.secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(agent.secretsEnc);
            if (dec) {
                try {
                    const secrets = JSON.parse(dec);
                    token = secrets.shopifyAdminToken ?? null;
                }
                catch {
                    token = null;
                }
            }
        }
        const shopDomain = agent.shopifyStoreUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? null;
        let webhookTopics = [];
        if (shopDomain && token) {
            webhookTopics = (await this.listWebhooks(shopDomain, token).catch(() => []))
                .filter((w) => w.address === this.webhookAddress())
                .map((w) => w.topic)
                .sort();
        }
        return {
            agentId: agent.id,
            agentName: agent.name,
            connected: Boolean(shopDomain && token),
            shopDomain,
            status: agent.shopifyConnectionStatus,
            lastConnectionTestAt: agent.lastConnectionTestAt,
            webhookTopics,
        };
    }
    actionFromTopic(topic) {
        return `SHOPIFY_${topic.replace(/[/.]/g, '_').toUpperCase()}`;
    }
    failureActionFromTopic(topic) {
        return `SHOPIFY_WEBHOOK_FAILED_${topic.replace(/[/.]/g, '_').toUpperCase()}`;
    }
    async tenantIdsForShopDomain(shopDomain) {
        const candidates = this.shopUrlCandidates(shopDomain);
        const [agents, connections] = await Promise.all([
            this.prisma.agent.findMany({
                where: { deletedAt: null, shopifyStoreUrl: { in: candidates } },
                select: { tenantId: true },
            }),
            this.prisma.shopifyConnection.findMany({
                where: { shopDomain: this.normalizeShopDomain(shopDomain) },
                select: { tenantId: true },
            }),
        ]);
        return [...new Set([...agents.map((a) => a.tenantId), ...connections.map((c) => c.tenantId)])];
    }
    async recordWebhookFailure(topic, shopDomain, reason, payload) {
        const domain = shopDomain.trim().toLowerCase();
        const tenantIds = await this.tenantIdsForShopDomain(domain);
        await Promise.all(tenantIds.map((tenantId) => this.prisma.auditLog.create({
            data: {
                tenantId,
                action: this.failureActionFromTopic(topic || 'unknown'),
                entityType: 'SHOPIFY_WEBHOOK_FAILURE',
                entityId: domain || 'unknown',
                metadata: {
                    topic,
                    shopDomain: domain,
                    reason,
                    payloadSummary: this.minimalWebhookPayload(topic, payload ?? {}),
                    payload: this.shouldStoreFullWebhookPayload() ? payload : undefined,
                    receivedAt: new Date().toISOString(),
                },
            },
        })));
    }
    async getWebhookHealth(tenantId, agentId) {
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { shopifyStoreUrl: true, secretsEnc: true },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        const shopDomain = agent.shopifyStoreUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? null;
        if (!shopDomain) {
            return {
                agentId,
                connected: false,
                shopDomain: null,
                lastSyncedAt: null,
                lastReceivedAtByTopic: Object.fromEntries(WEBHOOK_TOPICS.map((t) => [t, null])),
                lastFailureAtByTopic: Object.fromEntries(WEBHOOK_TOPICS.map((t) => [t, null])),
                failureCount24hByTopic: Object.fromEntries(WEBHOOK_TOPICS.map((t) => [t, 0])),
                totalFailures24h: 0,
                freshness: 'disconnected',
            };
        }
        const conn = await this.prisma.shopifyConnection.findFirst({
            where: { tenantId, shopDomain: shopDomain.toLowerCase() },
            select: { lastSyncedAt: true },
        });
        const successActions = WEBHOOK_TOPICS.map((t) => this.actionFromTopic(t));
        const failureActions = WEBHOOK_TOPICS.map((t) => this.failureActionFromTopic(t));
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [recentSuccess, recentFailure] = await Promise.all([
            this.prisma.auditLog.findMany({
                where: { tenantId, action: { in: successActions } },
                orderBy: { createdAt: 'desc' },
                take: 60,
                select: { action: true, createdAt: true, metadata: true },
            }),
            this.prisma.auditLog.findMany({
                where: { tenantId, action: { in: failureActions }, createdAt: { gte: since24h } },
                orderBy: { createdAt: 'desc' },
                take: 120,
                select: { action: true, createdAt: true, metadata: true },
            }),
        ]);
        const lastReceivedAtByTopic = {};
        const lastFailureAtByTopic = {};
        const failureCount24hByTopic = {};
        for (const t of WEBHOOK_TOPICS)
            lastReceivedAtByTopic[t] = null;
        for (const t of WEBHOOK_TOPICS)
            lastFailureAtByTopic[t] = null;
        for (const t of WEBHOOK_TOPICS)
            failureCount24hByTopic[t] = 0;
        for (const row of recentSuccess) {
            const meta = row.metadata;
            const metaShop = typeof meta?.shopDomain === 'string' ? meta.shopDomain.toLowerCase() : null;
            if (metaShop !== shopDomain.toLowerCase())
                continue;
            const topicKey = WEBHOOK_TOPICS.find((t) => this.actionFromTopic(t) === row.action) ?? null;
            if (!topicKey)
                continue;
            if (!lastReceivedAtByTopic[topicKey]) {
                lastReceivedAtByTopic[topicKey] = row.createdAt.toISOString();
            }
        }
        for (const row of recentFailure) {
            const meta = row.metadata;
            const metaShop = typeof meta?.shopDomain === 'string' ? meta.shopDomain.toLowerCase() : null;
            if (metaShop !== shopDomain.toLowerCase())
                continue;
            const topicKey = WEBHOOK_TOPICS.find((t) => this.failureActionFromTopic(t) === row.action) ?? null;
            if (!topicKey)
                continue;
            failureCount24hByTopic[topicKey] += 1;
            if (!lastFailureAtByTopic[topicKey]) {
                lastFailureAtByTopic[topicKey] = row.createdAt.toISOString();
            }
        }
        const latest = Object.values(lastReceivedAtByTopic)
            .filter((v) => typeof v === 'string' && v.length > 0)
            .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
        const freshness = (() => {
            if (!latest)
                return 'stale';
            const ageMs = Date.now() - new Date(latest).getTime();
            const ageHours = ageMs / (1000 * 60 * 60);
            if (ageHours <= 6)
                return 'fresh';
            if (ageHours <= 24)
                return 'ok';
            return 'stale';
        })();
        return {
            agentId,
            connected: true,
            shopDomain,
            lastSyncedAt: conn?.lastSyncedAt?.toISOString() ?? null,
            lastReceivedAtByTopic,
            lastFailureAtByTopic,
            failureCount24hByTopic,
            totalFailures24h: Object.values(failureCount24hByTopic).reduce((a, b) => a + b, 0),
            freshness,
            latestReceivedAt: latest,
        };
    }
    async disconnect(tenantId, agentId) {
        const agent = await this.prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { id: true, secretsEnc: true },
        });
        if (!agent)
            throw new common_1.NotFoundException('Agent not found.');
        let updatedSecretsEnc = null;
        if (agent.secretsEnc && this.encryption.isAvailable()) {
            const dec = this.encryption.decryptFromStorage(agent.secretsEnc);
            if (dec) {
                try {
                    const secrets = JSON.parse(dec);
                    delete secrets.shopifyAdminToken;
                    delete secrets.shopifyApiKey;
                    delete secrets.shopifyApiSecret;
                    delete secrets.webhookSecret;
                    updatedSecretsEnc = Object.keys(secrets).length > 0
                        ? this.encryption.encryptToStorage(JSON.stringify(secrets))
                        : null;
                }
                catch {
                    updatedSecretsEnc = null;
                }
            }
        }
        await this.prisma.agent.updateMany({
            where: { id: agentId, tenantId, deletedAt: null },
            data: {
                shopifyStoreUrl: null,
                shopifyConnectionStatus: client_1.ConnectionStatus.UNKNOWN,
                lastConnectionTestAt: new Date(),
                secretsEnc: updatedSecretsEnc,
            },
        });
        await this.prisma.auditLog.create({
            data: {
                tenantId,
                action: 'SHOPIFY_OAUTH_DISCONNECTED',
                entityType: 'SHOPIFY_CONNECTION',
                entityId: agentId,
                metadata: { agentId, disconnectedAt: new Date().toISOString() },
            },
        });
        return { disconnected: true };
    }
    parseTopicEntity(topic, payload) {
        if (topic.startsWith('orders/')) {
            const p = payload;
            return {
                entityType: 'SHOPIFY_ORDER',
                entityId: String(p.id ?? 'unknown'),
                summary: {
                    orderName: p.name,
                    financialStatus: p.financial_status,
                    fulfillmentStatus: p.fulfillment_status,
                    totalPrice: p.total_price,
                },
            };
        }
        if (topic.startsWith('carts/')) {
            const p = payload;
            return {
                entityType: 'SHOPIFY_CART',
                entityId: String(p.id ?? p.token ?? 'unknown'),
                summary: {
                    token: p.token,
                    currency: p.currency,
                    totalPrice: p.total_price,
                    itemCount: p.item_count,
                },
            };
        }
        if (topic.startsWith('products/')) {
            const p = payload;
            return {
                entityType: 'SHOPIFY_PRODUCT',
                entityId: String(p.id ?? 'unknown'),
                summary: {
                    title: p.title,
                    status: p.status,
                    vendor: p.vendor,
                },
            };
        }
        if (topic.startsWith('customers/')) {
            const p = payload;
            return {
                entityType: 'SHOPIFY_CUSTOMER',
                entityId: String(p.id ?? 'unknown'),
                summary: {
                    email: p.email,
                    phone: p.phone,
                    name: [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || undefined,
                },
            };
        }
        return {
            entityType: 'SHOPIFY_WEBHOOK',
            entityId: 'unknown',
            summary: {},
        };
    }
    normalizeEmail(value) {
        return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
    }
    maskEmail(value) {
        return (0, webhook_reconciliation_util_1.maskEmail)(value);
    }
    shouldStoreFullWebhookPayload() {
        return this.config.get('SHOPIFY_STORE_FULL_WEBHOOK_PAYLOAD') === 'true';
    }
    minimalWebhookPayload(topic, payload) {
        const p = payload;
        return (0, webhook_reconciliation_util_1.minimalWebhookPayload)(topic, {
            ...p,
            email: this.normalizeEmail(p.email),
            contact_email: this.normalizeEmail(p.contact_email),
        });
    }
    paymentStatusFromOrder(financialStatus, cancelledAt, closedAt) {
        const status = (financialStatus ?? '').toLowerCase();
        if (status === 'paid')
            return 'PAID';
        if (status === 'voided' || status === 'refunded')
            return 'FAILED';
        if (status === 'expired' || cancelledAt || closedAt)
            return 'EXPIRED';
        return 'PENDING';
    }
    checkoutStatusFromPaymentStatus(status) {
        if (status === 'PAID')
            return 'COMPLETED';
        if (status === 'FAILED')
            return 'FAILED';
        if (status === 'EXPIRED')
            return 'EXPIRED';
        return 'OPENED';
    }
    async findCheckoutLinkForOrder(tenantId, email, orderId) {
        const byRef = await this.prisma.checkoutLink.findFirst({
            where: { tenantId, providerRef: orderId },
            orderBy: { createdAt: 'desc' },
        });
        if (byRef)
            return byRef;
        if (!email)
            return null;
        return this.prisma.checkoutLink.findFirst({
            where: {
                tenantId,
                customerEmail: email,
                status: { in: ['CREATED', 'SENT', 'OPENED', 'COMPLETED'] },
            },
            orderBy: { createdAt: 'desc' },
        });
    }
    async reconcileOrderWebhookForTenant(tenantId, topic, domain, payload) {
        const p = payload;
        const orderId = String(p.id ?? '').trim();
        if (!orderId)
            return;
        const customerEmail = this.normalizeEmail(p.email) ?? this.normalizeEmail(p.contact_email);
        const checkout = await this.findCheckoutLinkForOrder(tenantId, customerEmail, orderId);
        if (!checkout) {
            await this.prisma.auditLog.create({
                data: {
                    tenantId,
                    action: 'SHOPIFY_ORDER_RECONCILE_SKIPPED',
                    entityType: 'SHOPIFY_ORDER',
                    entityId: orderId,
                    metadata: {
                        topic,
                        shopDomain: domain,
                        reason: 'checkout_link_not_found',
                        maskedCustomerEmail: this.maskEmail(customerEmail),
                    },
                },
            });
            return;
        }
        const paymentStatus = this.paymentStatusFromOrder(p.financial_status ?? null, p.cancelled_at ?? null, p.closed_at ?? null);
        const checkoutStatus = this.checkoutStatusFromPaymentStatus(paymentStatus);
        const paidAt = paymentStatus === 'PAID' ? new Date() : null;
        const failedAt = paymentStatus === 'FAILED' ? new Date() : null;
        const expiredAt = paymentStatus === 'EXPIRED' ? new Date() : null;
        const webhookEventKey = (0, webhook_reconciliation_util_1.buildPaymentWebhookEventKey)(topic, orderId, tenantId, checkout.id);
        await this.prisma.$transaction(async (tx) => {
            await tx.paymentRecord.upsert({
                where: { tenantId_webhookEventKey: { tenantId, webhookEventKey } },
                update: {
                    paymentStatus,
                    customerEmail: customerEmail ?? checkout.customerEmail ?? null,
                    shopifyOrderId: orderId,
                    shopifyOrderName: p.name ?? null,
                    paidAt: paymentStatus === 'PAID' ? (paidAt ?? undefined) : undefined,
                    failedAt: paymentStatus === 'FAILED' ? (failedAt ?? undefined) : undefined,
                    expiredAt: paymentStatus === 'EXPIRED' ? (expiredAt ?? undefined) : undefined,
                    lastWebhookTopic: topic,
                    rawWebhookPayloadJson: this.shouldStoreFullWebhookPayload()
                        ? payload
                        : this.minimalWebhookPayload(topic, payload),
                    metadata: {
                        financialStatus: p.financial_status ?? null,
                        cancelledAt: p.cancelled_at ?? null,
                        closedAt: p.closed_at ?? null,
                        maskedCustomerEmail: this.maskEmail(customerEmail),
                    },
                },
                create: {
                    tenantId,
                    agentId: checkout.agentId,
                    callSessionId: checkout.callSessionId,
                    checkoutLinkId: checkout.id,
                    customerEmail: customerEmail ?? checkout.customerEmail ?? null,
                    shopifyOrderId: orderId,
                    shopifyOrderName: p.name ?? null,
                    paymentStatus,
                    paidAt,
                    failedAt,
                    expiredAt,
                    webhookEventKey,
                    lastWebhookTopic: topic,
                    rawWebhookPayloadJson: this.shouldStoreFullWebhookPayload()
                        ? payload
                        : this.minimalWebhookPayload(topic, payload),
                    metadata: {
                        financialStatus: p.financial_status ?? null,
                        cancelledAt: p.cancelled_at ?? null,
                        closedAt: p.closed_at ?? null,
                        maskedCustomerEmail: this.maskEmail(customerEmail),
                    },
                },
            });
            await tx.checkoutLink.updateMany({
                where: { id: checkout.id, tenantId },
                data: {
                    status: checkoutStatus,
                    providerRef: orderId,
                    customerEmail: customerEmail ?? checkout.customerEmail ?? null,
                    completedAt: paymentStatus === 'PAID' ? (paidAt ?? undefined) : undefined,
                    metadata: {
                        ...(typeof checkout.metadata === 'object' && checkout.metadata ? checkout.metadata : {}),
                        paymentStatus,
                        shopifyOrderId: orderId,
                        shopifyOrderName: p.name ?? null,
                        lastWebhookTopic: topic,
                    },
                },
            });
        });
    }
    async handleWebhook(topic, shopDomain, payload) {
        const domain = shopDomain.trim().toLowerCase();
        const candidates = this.shopUrlCandidates(domain);
        const [agents, connections] = await Promise.all([
            this.prisma.agent.findMany({
                where: {
                    deletedAt: null,
                    shopifyStoreUrl: { in: candidates },
                },
                select: { tenantId: true, id: true },
            }),
            this.prisma.shopifyConnection.findMany({
                where: { shopDomain: this.normalizeShopDomain(domain) },
                select: { tenantId: true, storeId: true, id: true },
            }),
        ]);
        const entity = this.parseTopicEntity(topic, payload);
        const tenantIds = new Set([
            ...agents.map((a) => a.tenantId),
            ...connections.map((c) => c.tenantId),
        ]);
        await Promise.all([...tenantIds].map((tenantId) => this.prisma.auditLog.create({
            data: {
                tenantId,
                action: `SHOPIFY_${topic.replace(/[/.]/g, '_').toUpperCase()}`,
                entityType: entity.entityType,
                entityId: entity.entityId,
                metadata: {
                    topic,
                    shopDomain: domain,
                    summary: entity.summary,
                    payloadSummary: this.minimalWebhookPayload(topic, payload),
                    payload: this.shouldStoreFullWebhookPayload() ? payload : undefined,
                    receivedAt: new Date().toISOString(),
                },
            },
        })));
        if (topic === 'orders/create' || topic === 'orders/updated') {
            await Promise.all([...tenantIds].map((tenantId) => this.reconcileOrderWebhookForTenant(tenantId, topic, domain, payload).catch(async (err) => {
                const message = err instanceof Error ? err.message.slice(0, 300) : 'reconcile_failed';
                await this.prisma.auditLog.create({
                    data: {
                        tenantId,
                        action: 'SHOPIFY_ORDER_RECONCILE_FAILED',
                        entityType: 'SHOPIFY_ORDER',
                        entityId: String(payload?.id ?? 'unknown'),
                        metadata: {
                            topic,
                            shopDomain: domain,
                            message,
                        },
                    },
                });
            })));
        }
        if (connections.length > 0) {
            await this.prisma.shopifyConnection.updateMany({
                where: { id: { in: connections.map((c) => c.id) } },
                data: { lastSyncedAt: new Date() },
            });
        }
    }
};
exports.ShopifyService = ShopifyService;
exports.ShopifyService = ShopifyService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService])
], ShopifyService);
//# sourceMappingURL=shopify.service.js.map