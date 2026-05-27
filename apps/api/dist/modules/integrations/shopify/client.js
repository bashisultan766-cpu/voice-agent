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
var ShopifyClientService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyClientService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const encryption_service_1 = require("../../../common/encryption.service");
const credential_resolver_util_1 = require("../../../common/credential-resolver.util");
const provider_env_slice_util_1 = require("../../../common/provider-env-slice.util");
const shopify_errors_1 = require("./shopify-errors");
const DEFAULT_GRAPHQL_ATTEMPTS = Number(process.env.SHOPIFY_GRAPHQL_MAX_ATTEMPTS) || 4;
const DEFAULT_GRAPHQL_BASE_DELAY_MS = Number(process.env.SHOPIFY_GRAPHQL_RETRY_BASE_MS) || 400;
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
let ShopifyClientService = ShopifyClientService_1 = class ShopifyClientService {
    constructor(prisma, encryption) {
        this.prisma = prisma;
        this.encryption = encryption;
        this.logger = new common_1.Logger(ShopifyClientService_1.name);
    }
    normalizeDomain(rawUrl) {
        return rawUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
    }
    async getAgentShopifyConfig(tenantId, agentId) {
        const agent = await this.prisma.agent.findFirstOrThrow({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                shopifyStoreUrl: true,
                secretsEnc: true,
                storeId: true,
                agentConfig: { select: { useWorkspaceShopify: true, shopifyApiVersion: true } },
            },
        });
        if (!this.encryption.isAvailable()) {
            throw new Error('Encrypted Shopify credentials are unavailable.');
        }
        let secrets = {};
        if (agent.secretsEnc) {
            const decrypted = this.encryption.decryptFromStorage(agent.secretsEnc);
            if (decrypted) {
                try {
                    secrets = JSON.parse(decrypted);
                }
                catch {
                    secrets = {};
                }
            }
        }
        const integration = await this.prisma.tenantIntegration.findUnique({
            where: { tenantId },
            select: { shopifyShopDomain: true, shopifyAdminTokenEnc: true },
        });
        const workspace = integration && this.encryption.isAvailable()
            ? {
                shopifyStoreUrl: integration.shopifyShopDomain?.trim()
                    ? `https://${integration.shopifyShopDomain.trim()}`
                    : undefined,
                shopifyAdminToken: integration.shopifyAdminTokenEnc
                    ? (this.encryption.decryptFromStorage(integration.shopifyAdminTokenEnc) ?? undefined)
                    : undefined,
            }
            : null;
        const resolved = (0, credential_resolver_util_1.resolveShopifyConfig)({
            agent: {
                shopifyStoreUrl: agent.shopifyStoreUrl,
                secrets,
                useWorkspaceShopify: agent.agentConfig?.useWorkspaceShopify === true,
                shopifyApiVersion: agent.agentConfig?.shopifyApiVersion,
            },
            workspace,
            env: (0, provider_env_slice_util_1.buildProviderEnvSlice)(),
        });
        if (!resolved) {
            throw new Error('Shopify credentials missing for this agent.');
        }
        (0, credential_resolver_util_1.logCredentialResolution)(this.logger, 'shopify', resolved.source, agentId);
        const normalizedDomain = this.normalizeDomain(resolved.shopifyStoreUrl);
        const connection = agent.storeId
            ? await this.prisma.shopifyConnection.findFirst({
                where: { tenantId, storeId: agent.storeId },
                select: { id: true, shopDomain: true },
            })
            : await this.prisma.shopifyConnection.findFirst({
                where: { tenantId, shopDomain: normalizedDomain },
                select: { id: true, shopDomain: true },
            });
        const domain = normalizedDomain ||
            (connection?.shopDomain ? this.normalizeDomain(`https://${connection.shopDomain}`) : '');
        if (!domain)
            throw new Error('Shopify store domain could not be resolved for this agent.');
        return {
            domain,
            token: resolved.shopifyAdminToken,
            shopifyConnectionId: connection?.id ?? null,
            apiVersion: resolved.shopifyApiVersion,
            source: resolved.source,
        };
    }
    parseGraphqlPayload(body, httpStatus) {
        if (!body || typeof body !== 'object') {
            throw new shopify_errors_1.ShopifyGraphqlError(`Shopify Admin GraphQL returned a non-JSON body (HTTP ${httpStatus}).`, [{ message: 'Invalid JSON response' }], httpStatus);
        }
        const b = body;
        const normalizedErrors = Array.isArray(b.errors)
            ? b.errors.map((row) => {
                if (row && typeof row === 'object') {
                    const r = row;
                    return {
                        message: typeof r.message === 'string' ? r.message : JSON.stringify(row).slice(0, 300),
                        extensions: r.extensions && typeof r.extensions === 'object'
                            ? r.extensions
                            : undefined,
                        locations: r.locations,
                    };
                }
                return { message: String(row) };
            })
            : typeof b.errors === 'string'
                ? [{ message: b.errors }]
                : [];
        return { data: b.data, errors: normalizedErrors };
    }
    async executeGraphqlOnce(domain, token, apiVersion, query, variables) {
        const response = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': token,
            },
            body: JSON.stringify({ query, variables }),
        });
        const json = (await response.json().catch(() => null));
        const { data, errors } = this.parseGraphqlPayload(json, response.status);
        if (!response.ok) {
            const msg = errors?.[0]?.message ||
                (typeof json === 'object' && json !== null && 'errors' in json
                    ? JSON.stringify(json.errors).slice(0, 400)
                    : `HTTP ${response.status}`);
            throw new shopify_errors_1.ShopifyGraphqlError(`Shopify Admin GraphQL HTTP ${response.status}: ${msg}`, errors?.length ? errors : [{ message: msg }], response.status);
        }
        if (errors?.length) {
            throw new shopify_errors_1.ShopifyGraphqlError(errors.map((e) => e.message).join('; ') || 'GraphQL errors', errors, response.status);
        }
        if (data === undefined || data === null) {
            throw new shopify_errors_1.ShopifyGraphqlError('Shopify Admin API returned empty data.', errors?.length ? errors : [{ message: 'empty data' }], response.status);
        }
        return data;
    }
    async adminGraphql(domain, token, query, variables, apiVersion = '2024-10') {
        let lastErr;
        for (let attempt = 0; attempt < DEFAULT_GRAPHQL_ATTEMPTS; attempt++) {
            try {
                return (await this.executeGraphqlOnce(domain, token, apiVersion, query, variables));
            }
            catch (err) {
                lastErr = err;
                const retryable = (0, shopify_errors_1.isShopifyRetryableError)(err);
                if (!retryable || attempt === DEFAULT_GRAPHQL_ATTEMPTS - 1)
                    throw err;
                const jitter = Math.floor(Math.random() * 120);
                await sleep(DEFAULT_GRAPHQL_BASE_DELAY_MS * 2 ** attempt + jitter);
            }
        }
        throw lastErr;
    }
    async adminRest(domain, token, path, init, apiVersion = '2024-10') {
        let lastErr;
        for (let attempt = 0; attempt < DEFAULT_GRAPHQL_ATTEMPTS; attempt++) {
            try {
                const response = await fetch(`https://${domain}/admin/api/${apiVersion}/${path.replace(/^\//, '')}`, {
                    ...init,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': token,
                        ...(init?.headers ?? {}),
                    },
                });
                const text = await response.text();
                let payload;
                try {
                    payload = text ? JSON.parse(text) : {};
                }
                catch {
                    payload = { raw: text.slice(0, 500) };
                }
                const body = payload;
                if (!response.ok) {
                    const message = (typeof body?.errors === 'string' && body.errors) ||
                        (Array.isArray(body?.errors) ? JSON.stringify(body.errors).slice(0, 300) : null) ||
                        (typeof body?.error === 'string' && body.error) ||
                        `Shopify REST API failed (${response.status}).`;
                    throw new shopify_errors_1.ShopifyRestError(message, response.status, text.slice(0, 400));
                }
                if (typeof body === 'object' && body !== null && 'errors' in body && body.errors) {
                    throw new shopify_errors_1.ShopifyRestError(`Shopify REST API returned errors: ${JSON.stringify(body.errors).slice(0, 400)}`, 422, text.slice(0, 400));
                }
                return body;
            }
            catch (err) {
                lastErr = err;
                const retryable = (0, shopify_errors_1.isShopifyRetryableError)(err);
                if (!retryable || attempt === DEFAULT_GRAPHQL_ATTEMPTS - 1)
                    throw err;
                const jitter = Math.floor(Math.random() * 120);
                await sleep(DEFAULT_GRAPHQL_BASE_DELAY_MS * 2 ** attempt + jitter);
            }
        }
        throw lastErr;
    }
};
exports.ShopifyClientService = ShopifyClientService;
exports.ShopifyClientService = ShopifyClientService = ShopifyClientService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService])
], ShopifyClientService);
//# sourceMappingURL=client.js.map