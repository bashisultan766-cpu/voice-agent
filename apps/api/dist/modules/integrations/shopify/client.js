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
exports.ShopifyClientService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const encryption_service_1 = require("../../../common/encryption.service");
const shopify_errors_1 = require("./shopify-errors");
const DEFAULT_GRAPHQL_ATTEMPTS = Number(process.env.SHOPIFY_GRAPHQL_MAX_ATTEMPTS) || 4;
const DEFAULT_GRAPHQL_BASE_DELAY_MS = Number(process.env.SHOPIFY_GRAPHQL_RETRY_BASE_MS) || 400;
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
let ShopifyClientService = class ShopifyClientService {
    constructor(prisma, encryption) {
        this.prisma = prisma;
        this.encryption = encryption;
    }
    normalizeDomain(rawUrl) {
        return rawUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
    }
    async getAgentShopifyConfig(tenantId, agentId) {
        const agent = await this.prisma.agent.findFirstOrThrow({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { shopifyStoreUrl: true, secretsEnc: true, storeId: true },
        });
        if (!agent.shopifyStoreUrl)
            throw new Error('Shopify store URL is not configured for this agent.');
        if (!this.encryption.isAvailable())
            throw new Error('Encrypted Shopify credentials are unavailable.');
        let token = null;
        let agentToken = null;
        if (agent.secretsEnc) {
            const decrypted = this.encryption.decryptFromStorage(agent.secretsEnc);
            if (decrypted) {
                try {
                    const parsed = JSON.parse(decrypted);
                    agentToken = parsed.shopifyAdminToken?.trim() || null;
                }
                catch {
                    agentToken = null;
                }
            }
        }
        const normalizedDomain = this.normalizeDomain(agent.shopifyStoreUrl);
        const connection = agent.storeId
            ? await this.prisma.shopifyConnection.findFirst({
                where: { tenantId, storeId: agent.storeId },
                select: { id: true, accessTokenEnc: true, shopDomain: true },
            })
            : await this.prisma.shopifyConnection.findFirst({
                where: { tenantId, shopDomain: normalizedDomain },
                select: { id: true, accessTokenEnc: true, shopDomain: true },
            });
        if (connection?.accessTokenEnc) {
            const decTok = this.encryption.decryptFromStorage(connection.accessTokenEnc);
            if (decTok?.trim())
                token = decTok.trim();
        }
        if (!token?.trim() && agentToken?.trim())
            token = agentToken.trim();
        if (!token?.trim())
            throw new Error('Shopify Admin token is missing for this agent.');
        const domain = normalizedDomain ||
            (connection?.shopDomain ? this.normalizeDomain(`https://${connection.shopDomain}`) : '');
        if (!domain)
            throw new Error('Shopify store domain could not be resolved for this agent.');
        return {
            domain,
            token: token.trim(),
            shopifyConnectionId: connection?.id ?? null,
        };
    }
    parseGraphqlPayload(body, httpStatus) {
        if (!body || typeof body !== 'object') {
            throw new shopify_errors_1.ShopifyGraphqlError(`Shopify Admin GraphQL returned a non-JSON body (HTTP ${httpStatus}).`, [{ message: 'Invalid JSON response' }], httpStatus);
        }
        const b = body;
        const normalizedErrors = Array.isArray(b.errors)
            ? b.errors
                .map((row) => {
                if (row && typeof row === 'object') {
                    const r = row;
                    return {
                        message: typeof r.message === 'string' ? r.message : JSON.stringify(row).slice(0, 300),
                        extensions: r.extensions && typeof r.extensions === 'object' ? r.extensions : undefined,
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
    async executeGraphqlOnce(domain, token, query, variables) {
        const response = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
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
    async adminGraphql(domain, token, query, variables) {
        let lastErr;
        for (let attempt = 0; attempt < DEFAULT_GRAPHQL_ATTEMPTS; attempt++) {
            try {
                return await this.executeGraphqlOnce(domain, token, query, variables);
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
    async adminRest(domain, token, path, init) {
        let lastErr;
        for (let attempt = 0; attempt < DEFAULT_GRAPHQL_ATTEMPTS; attempt++) {
            try {
                const response = await fetch(`https://${domain}/admin/api/2024-10/${path.replace(/^\//, '')}`, {
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
exports.ShopifyClientService = ShopifyClientService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService])
], ShopifyClientService);
//# sourceMappingURL=client.js.map