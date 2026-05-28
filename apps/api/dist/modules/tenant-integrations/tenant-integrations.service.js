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
var TenantIntegrationsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantIntegrationsService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../database/prisma.service");
const encryption_service_1 = require("../../common/encryption.service");
const shopify_connection_test_service_1 = require("../agents/connection-test/shopify-connection-test.service");
const twilio_connection_test_service_1 = require("../agents/connection-test/twilio-connection-test.service");
const openai_connection_test_service_1 = require("../agents/connection-test/openai-connection-test.service");
const elevenlabs_connection_test_service_1 = require("../agents/connection-test/elevenlabs-connection-test.service");
const types_1 = require("@bookstore-voice-agents/types");
const resend_api_util_1 = require("./resend-api.util");
function last4(value) {
    const s = value?.trim();
    if (!s || s.length < 4)
        return null;
    return s.slice(-4);
}
function maskKindHint(kind, last4) {
    const s = last4?.trim();
    if (!s || s.length < 4)
        return null;
    if (kind === 'shopify')
        return `shpat_****${s}`;
    if (kind === 'openai')
        return `sk-****${s}`;
    if (kind === 'elevenlabs')
        return `xi_****${s}`;
    return `re_****${s}`;
}
function openaiKeyPrefixHint(value) {
    const key = value?.trim().toLowerCase();
    if (!key)
        return null;
    if (key.startsWith('sk-proj-'))
        return 'sk-proj-';
    if (key.startsWith('sk-'))
        return 'sk-';
    return null;
}
function isPlausibleTwilioAccountSid(sid) {
    return /^AC[0-9a-f]{32}$/i.test(sid.trim());
}
function isE164Phone(phone) {
    return /^\+[1-9]\d{6,14}$/.test(phone.trim());
}
function sanitizeLogError(err) {
    if (err instanceof common_1.BadRequestException) {
        const r = err.getResponse();
        if (typeof r === 'string')
            return r.slice(0, 240);
        if (r && typeof r === 'object' && 'message' in r) {
            const m = r.message;
            if (typeof m === 'string')
                return m.slice(0, 240);
        }
    }
    if (err instanceof Error)
        return err.message.slice(0, 240);
    return String(err).slice(0, 240);
}
function storeSlugFromMyshopifyDomain(domain) {
    const host = (0, types_1.normalizeShopifyDomain)(domain) || domain.trim().toLowerCase();
    const base = host.replace(/\.myshopify\.com$/i, '') || host;
    return (base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'store');
}
function canonicalMyshopifyHostname(input) {
    let s = (0, types_1.normalizeShopifyDomain)(input) || input.trim().toLowerCase();
    s = s.replace(/\/$/, '');
    const hostOnly = (s.split('/')[0] ?? s).split('?')[0] ?? s;
    let h = hostOnly.trim().toLowerCase();
    if (!h.endsWith('.myshopify.com')) {
        const sub = h.replace(/\.myshopify\.com$/i, '').replace(/^https?:\/\//i, '');
        h = `${sub}.myshopify.com`.toLowerCase();
    }
    return h;
}
function shopifyHostsMatch(a, b) {
    return canonicalMyshopifyHostname(a) === canonicalMyshopifyHostname(b);
}
function isBogusOrMaskedShopifyAdminToken(raw) {
    if (raw === undefined || raw === null)
        return true;
    const t = raw.trim();
    if (!t)
        return true;
    if (/^[\u2022\u00B7\u2219•·\*\u25CF●○◦\s]+$/.test(t))
        return true;
    if (/^shpat_[•·\*\s]+$/i.test(t))
        return true;
    return false;
}
let TenantIntegrationsService = TenantIntegrationsService_1 = class TenantIntegrationsService {
    isSchemaDriftError(err) {
        return (err instanceof client_1.Prisma.PrismaClientKnownRequestError &&
            (err.code === 'P2021' || err.code === 'P2022'));
    }
    buildSchemaDriftMessage(provider, err) {
        const meta = (err.meta ?? {});
        const table = typeof meta.table === 'string' ? meta.table : null;
        const column = typeof meta.column === 'string' ? meta.column : null;
        const model = typeof meta.modelName === 'string' ? meta.modelName : null;
        const target = column
            ? `missing column "${column}"`
            : table
                ? `missing table "${table}"`
                : model
                    ? `schema mismatch around model "${model}"`
                    : 'database schema mismatch';
        const base = `Database migration required for ${provider} integration (${target}). Run pnpm --filter api exec prisma migrate deploy (or pnpm --filter api exec prisma migrate dev for local development), then retry.`;
        if (process.env.NODE_ENV !== 'production') {
            return `${base} Prisma ${err.code}: ${err.message}`;
        }
        return base;
    }
    mapIntegrationError(provider, err) {
        if (err instanceof common_1.BadRequestException)
            throw err;
        if (this.isSchemaDriftError(err)) {
            throw new common_1.BadRequestException(this.buildSchemaDriftMessage(provider, err));
        }
        throw err;
    }
    constructor(prisma, encryption, shopifyTest, twilioTest, openaiTest, elevenlabsTest) {
        this.prisma = prisma;
        this.encryption = encryption;
        this.shopifyTest = shopifyTest;
        this.twilioTest = twilioTest;
        this.openaiTest = openaiTest;
        this.elevenlabsTest = elevenlabsTest;
        this.log = new common_1.Logger(TenantIntegrationsService_1.name);
    }
    audit(op, provider, tenantId, ok, err) {
        const payload = {
            event: 'tenant_integration',
            op,
            provider,
            tenantId,
            ok,
            ...(err != null ? { error: sanitizeLogError(err) } : {}),
        };
        if (ok)
            this.log.log(JSON.stringify(payload));
        else
            this.log.warn(JSON.stringify(payload));
    }
    async getTenantIntegrationRowResilient(tenantId) {
        const columns = (await this.prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='TenantIntegration'`)).map((r) => r.column_name);
        if (!columns.length)
            return null;
        const set = new Set(columns);
        const wanted = [
            'shopifyShopDomain',
            'shopifyAdminTokenEnc',
            'shopifyTokenLast4',
            'shopifyLastTestOk',
            'shopifyLastTestAt',
            'twilioAccountSid',
            'twilioAuthTokenEnc',
            'twilioPhoneNumber',
            'twilioLastTestOk',
            'twilioLastTestAt',
            'openaiApiKeyEnc',
            'openaiKeyLast4',
            'openaiKeyPrefix',
            'openaiLastTestOk',
            'openaiLastTestAt',
            'elevenlabsApiKeyEnc',
            'elevenlabsKeyLast4',
            'elevenlabsDefaultVoiceId',
            'elevenlabsDefaultModel',
            'elevenlabsLastTestOk',
            'elevenlabsLastTestAt',
            'resendApiKeyEnc',
            'resendKeyLast4',
            'resendFromEmail',
            'emailLastTestOk',
            'emailLastTestAt',
        ];
        const select = wanted
            .map((name) => (set.has(name) ? `"${name}"` : `NULL AS "${name}"`))
            .join(', ');
        const rows = await this.prisma.$queryRawUnsafe(`SELECT ${select} FROM "TenantIntegration" WHERE "tenantId" = $1 LIMIT 1`, tenantId);
        return rows[0] ?? null;
    }
    async getSafeSummary(tenantId) {
        try {
            const row = await this.getTenantIntegrationRowResilient(tenantId);
            if (!row) {
                return {
                    shopify: {
                        configured: false,
                        shopDomain: null,
                        tokenMasked: null,
                        lastTestOk: null,
                        lastTestAt: null,
                    },
                    twilio: {
                        configured: false,
                        accountSidLast4: null,
                        phoneNumber: null,
                        lastTestOk: null,
                        lastTestAt: null,
                    },
                    openai: {
                        configured: false,
                        keyMasked: null,
                        lastTestOk: null,
                        lastTestAt: null,
                    },
                    elevenlabs: {
                        configured: false,
                        keyMasked: null,
                        defaultVoiceId: null,
                        defaultModel: null,
                        lastTestOk: null,
                        lastTestAt: null,
                    },
                    email: {
                        configured: false,
                        fromEmail: null,
                        keyMasked: null,
                        lastTestOk: null,
                        lastTestAt: null,
                    },
                };
            }
            const dateIso = (value) => (value instanceof Date ? value.toISOString() : null);
            const str = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
            const bool = (value) => (typeof value === 'boolean' ? value : null);
            return {
                shopify: {
                    configured: Boolean(str(row.shopifyShopDomain) && str(row.shopifyAdminTokenEnc)),
                    shopDomain: str(row.shopifyShopDomain),
                    tokenMasked: maskKindHint('shopify', str(row.shopifyTokenLast4)),
                    lastTestOk: bool(row.shopifyLastTestOk),
                    lastTestAt: dateIso(row.shopifyLastTestAt),
                },
                twilio: {
                    configured: Boolean(str(row.twilioAccountSid) &&
                        str(row.twilioAuthTokenEnc) &&
                        str(row.twilioPhoneNumber)),
                    accountSidLast4: last4(str(row.twilioAccountSid)),
                    phoneNumber: str(row.twilioPhoneNumber),
                    lastTestOk: bool(row.twilioLastTestOk),
                    lastTestAt: dateIso(row.twilioLastTestAt),
                },
                openai: {
                    configured: Boolean(str(row.openaiApiKeyEnc)),
                    keyMasked: (() => {
                        const l4 = str(row.openaiKeyLast4);
                        if (!l4 || l4.length < 4)
                            return null;
                        const prefix = str(row.openaiKeyPrefix) || 'sk-';
                        return `${prefix}****${l4}`;
                    })(),
                    lastTestOk: bool(row.openaiLastTestOk),
                    lastTestAt: dateIso(row.openaiLastTestAt),
                },
                elevenlabs: {
                    configured: Boolean(str(row.elevenlabsApiKeyEnc)),
                    keyMasked: maskKindHint('elevenlabs', str(row.elevenlabsKeyLast4)),
                    defaultVoiceId: str(row.elevenlabsDefaultVoiceId),
                    defaultModel: str(row.elevenlabsDefaultModel),
                    lastTestOk: bool(row.elevenlabsLastTestOk),
                    lastTestAt: dateIso(row.elevenlabsLastTestAt),
                },
                email: {
                    configured: Boolean(str(row.resendApiKeyEnc) && str(row.resendFromEmail)),
                    fromEmail: str(row.resendFromEmail),
                    keyMasked: maskKindHint('resend', str(row.resendKeyLast4)),
                    lastTestOk: bool(row.emailLastTestOk),
                    lastTestAt: dateIso(row.emailLastTestAt),
                },
            };
        }
        catch (e) {
            this.audit('summary', 'summary', tenantId, false, e);
            this.mapIntegrationError('summary', e);
        }
    }
    async testShopify(tenantId, body) {
        const hostRaw = body.shopDomain?.trim();
        if (!hostRaw) {
            throw new common_1.BadRequestException('Shop domain is required.');
        }
        const domain = canonicalMyshopifyHostname(hostRaw);
        if (!domain.endsWith('.myshopify.com')) {
            throw new common_1.BadRequestException('Use your store myshopify.com hostname (e.g. your-store.myshopify.com).');
        }
        let incoming = body.accessToken?.trim();
        if (incoming && isBogusOrMaskedShopifyAdminToken(incoming)) {
            incoming = undefined;
        }
        let token;
        if (incoming) {
            token = incoming;
        }
        else {
            const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
            if (!row?.shopifyAdminTokenEnc || !row.shopifyShopDomain?.trim()) {
                throw new common_1.BadRequestException('Shop domain and access token are required.');
            }
            if (!shopifyHostsMatch(row.shopifyShopDomain, domain)) {
                throw new common_1.BadRequestException('Enter a new access token to test this shop domain, or use the domain that matches your saved connection.');
            }
            if (!this.encryption.isAvailable()) {
                throw new common_1.BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
            }
            const dec = this.encryption.decryptFromStorage(row.shopifyAdminTokenEnc);
            if (!dec?.trim()) {
                throw new common_1.BadRequestException('Could not read saved token. Enter a new Admin API access token.');
            }
            token = dec.trim();
        }
        const r = await this.shopifyTest.testConnection({
            shopifyStoreUrl: `https://${domain}`,
            shopifyAdminToken: token,
        });
        this.audit('test', 'shopify', tenantId, r.success, r.success ? undefined : r.message);
        return { success: r.success, message: r.message, warnings: r.warnings };
    }
    async saveShopify(tenantId, body) {
        try {
            if (!this.encryption.isAvailable()) {
                throw new common_1.BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
            }
            const hostRaw = body.shopDomain?.trim();
            if (!hostRaw) {
                throw new common_1.BadRequestException('Shop domain is required.');
            }
            const domain = canonicalMyshopifyHostname(hostRaw);
            if (!domain.endsWith('.myshopify.com')) {
                throw new common_1.BadRequestException('Use your store myshopify.com hostname (e.g. your-store.myshopify.com).');
            }
            let incoming = body.accessToken?.trim();
            if (incoming && isBogusOrMaskedShopifyAdminToken(incoming)) {
                incoming = undefined;
            }
            let tokenPlain;
            let enc;
            let tokLast4;
            if (incoming) {
                tokenPlain = incoming;
                const encNew = this.encryption.encryptToStorage(tokenPlain);
                if (!encNew)
                    throw new common_1.BadRequestException('Could not encrypt Shopify token.');
                enc = encNew;
                tokLast4 = last4(tokenPlain);
            }
            else {
                const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
                if (!row?.shopifyAdminTokenEnc) {
                    throw new common_1.BadRequestException('Shop domain and access token are required.');
                }
                if (!shopifyHostsMatch(row.shopifyShopDomain || '', domain)) {
                    throw new common_1.BadRequestException('Enter a new Admin API access token when changing shop domain.');
                }
                const dec = this.encryption.decryptFromStorage(row.shopifyAdminTokenEnc);
                if (!dec?.trim()) {
                    throw new common_1.BadRequestException('Could not read saved token. Enter a new Admin API access token.');
                }
                tokenPlain = dec.trim();
                enc = row.shopifyAdminTokenEnc;
                tokLast4 = row.shopifyTokenLast4 ?? last4(tokenPlain);
            }
            if (!body.skipConnectionTest) {
                const test = await this.shopifyTest.testConnection({
                    shopifyStoreUrl: `https://${domain}`,
                    shopifyAdminToken: tokenPlain,
                });
                if (!test.success) {
                    throw new common_1.BadRequestException(test.message || 'Shopify connection test failed.');
                }
            }
            const slug = storeSlugFromMyshopifyDomain(domain);
            const store = await this.prisma.$transaction(async (tx) => {
                let s = await tx.store.findFirst({
                    where: { tenantId, slug, deletedAt: null },
                });
                if (!s) {
                    s = await tx.store.create({
                        data: {
                            tenantId,
                            name: domain.replace('.myshopify.com', ''),
                            slug,
                        },
                    });
                }
                await tx.shopifyConnection.upsert({
                    where: { storeId: s.id },
                    create: {
                        tenantId,
                        storeId: s.id,
                        shopDomain: domain,
                        accessTokenEnc: enc,
                        connectedAt: new Date(),
                    },
                    update: {
                        shopDomain: domain,
                        accessTokenEnc: enc,
                        connectedAt: new Date(),
                    },
                });
                const now = new Date();
                await tx.tenantIntegration.upsert({
                    where: { tenantId },
                    create: {
                        tenantId,
                        shopifyShopDomain: domain,
                        shopifyAdminTokenEnc: enc,
                        shopifyTokenLast4: tokLast4,
                        shopifyLastTestOk: true,
                        shopifyLastTestAt: now,
                    },
                    update: {
                        shopifyShopDomain: domain,
                        shopifyAdminTokenEnc: enc,
                        shopifyTokenLast4: tokLast4,
                        shopifyLastTestOk: true,
                        shopifyLastTestAt: now,
                    },
                });
                return s;
            });
            this.audit('save', 'shopify', tenantId, true);
            return { ok: true, storeId: store.id, shopDomain: domain };
        }
        catch (e) {
            this.audit('save', 'shopify', tenantId, false, e);
            throw e;
        }
    }
    async testTwilio(tenantId, body) {
        const sidIn = body.accountSid?.trim() ?? '';
        if (sidIn && !isPlausibleTwilioAccountSid(sidIn)) {
            const out = {
                success: false,
                message: 'Account SID should look like AC followed by 32 hex characters.',
            };
            this.audit('test', 'twilio', tenantId, false, out.message);
            return out;
        }
        const phoneRaw = body.phoneNumber?.trim();
        const phone = phoneRaw ? (0, types_1.normalizePhoneNumber)(phoneRaw) : undefined;
        if (phone && !isE164Phone(phone)) {
            const out = {
                success: false,
                message: 'Phone number should be in E.164 format (e.g. +15551234567).',
            };
            this.audit('test', 'twilio', tenantId, false, out.message);
            return out;
        }
        const r = await this.twilioTest.testConnection({
            twilioAccountSid: body.accountSid,
            twilioAuthToken: body.authToken,
        });
        if (!r.success) {
            this.audit('test', 'twilio', tenantId, false, r.message);
            return r;
        }
        if (phone) {
            const pSid = await this.twilioTest.resolveIncomingPhoneSid({
                twilioAccountSid: body.accountSid,
                twilioAuthToken: body.authToken,
                twilioPhoneNumber: phone,
            });
            if (!pSid) {
                const out = {
                    success: false,
                    message: 'Account credentials are valid, but the phone number was not found on this Twilio account.',
                };
                this.audit('test', 'twilio', tenantId, false, out.message);
                return out;
            }
        }
        this.audit('test', 'twilio', tenantId, true);
        return r;
    }
    async saveTwilio(tenantId, body) {
        try {
            if (!this.encryption.isAvailable()) {
                throw new common_1.BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
            }
            const accountSid = body.accountSid?.trim();
            const authToken = body.authToken?.trim();
            const phoneNumberRaw = body.phoneNumber?.trim();
            if (!accountSid || !authToken || !phoneNumberRaw) {
                throw new common_1.BadRequestException('Account SID, auth token, and phone number are required.');
            }
            const phoneNumber = (0, types_1.normalizePhoneNumber)(phoneNumberRaw);
            if (!isPlausibleTwilioAccountSid(accountSid)) {
                throw new common_1.BadRequestException('Account SID should look like AC followed by 32 hex characters.');
            }
            if (!isE164Phone(phoneNumber)) {
                throw new common_1.BadRequestException('Phone number must be in E.164 format (e.g. +15551234567).');
            }
            if (!body.skipConnectionTest) {
                const test = await this.twilioTest.testConnection({
                    twilioAccountSid: accountSid,
                    twilioAuthToken: authToken,
                });
                if (!test.success) {
                    throw new common_1.BadRequestException(test.message || 'Twilio connection test failed.');
                }
                const phoneSid = await this.twilioTest.resolveIncomingPhoneSid({
                    twilioAccountSid: accountSid,
                    twilioAuthToken: authToken,
                    twilioPhoneNumber: phoneNumber,
                });
                if (!phoneSid) {
                    throw new common_1.BadRequestException('Phone number not found on this Twilio account. Check E.164 format (+1…).');
                }
            }
            const enc = this.encryption.encryptToStorage(authToken);
            if (!enc)
                throw new common_1.BadRequestException('Could not encrypt Twilio auth token.');
            const phoneSid = (await this.twilioTest.resolveIncomingPhoneSid({
                twilioAccountSid: accountSid,
                twilioAuthToken: authToken,
                twilioPhoneNumber: phoneNumber,
            })) || `manual-${phoneNumber.replace(/\D/g, '')}`;
            const now = new Date();
            await this.prisma.$transaction(async (tx) => {
                await tx.tenantIntegration.upsert({
                    where: { tenantId },
                    create: {
                        tenantId,
                        twilioAccountSid: accountSid,
                        twilioAuthTokenEnc: enc,
                        twilioPhoneNumber: phoneNumber,
                        twilioPhoneSid: phoneSid,
                        twilioLastTestOk: true,
                        twilioLastTestAt: now,
                    },
                    update: {
                        twilioAccountSid: accountSid,
                        twilioAuthTokenEnc: enc,
                        twilioPhoneNumber: phoneNumber,
                        twilioPhoneSid: phoneSid,
                        twilioLastTestOk: true,
                        twilioLastTestAt: now,
                    },
                });
                await tx.phoneNumber.upsert({
                    where: {
                        tenantId_twilioSid: { tenantId, twilioSid: phoneSid },
                    },
                    create: {
                        tenantId,
                        twilioSid: phoneSid,
                        phoneNumber,
                        friendlyName: 'Workspace default',
                        status: 'UNASSIGNED',
                    },
                    update: {
                        phoneNumber,
                        friendlyName: 'Workspace default',
                    },
                });
            });
            this.audit('save', 'twilio', tenantId, true);
            return { ok: true };
        }
        catch (e) {
            this.audit('save', 'twilio', tenantId, false, e);
            throw e;
        }
    }
    async testOpenai(tenantId, body) {
        let key = body.apiKey?.trim();
        if (!key) {
            if (!this.encryption.isAvailable()) {
                throw new common_1.BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
            }
            const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
            if (!row?.openaiApiKeyEnc) {
                throw new common_1.BadRequestException('API key is required (no existing workspace key on file).');
            }
            const decrypted = this.encryption.decryptFromStorage(row.openaiApiKeyEnc);
            if (!decrypted?.trim()) {
                throw new common_1.BadRequestException('Could not read existing OpenAI key; re-enter your API key.');
            }
            key = decrypted.trim();
        }
        this.log.log(JSON.stringify({
            provider: 'openai',
            operation: 'test',
            tenantId,
            hasApiKey: Boolean(key),
            keyLength: key.length,
        }));
        const r = await this.openaiTest.testConnection({ openaiApiKey: key });
        this.audit('test', 'openai', tenantId, r.success, r.success ? undefined : r.message);
        return { success: r.success, message: r.message, warnings: r.warnings };
    }
    async saveOpenai(tenantId, body) {
        try {
            if (!this.encryption.isAvailable()) {
                throw new common_1.BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
            }
            const keyIn = body.apiKey?.trim();
            this.log.log(JSON.stringify({
                provider: 'openai',
                operation: 'save',
                tenantId,
                hasApiKey: Boolean(keyIn),
                keyLength: keyIn?.length ?? 0,
            }));
            const now = new Date();
            let enc;
            let keyLast4;
            let keyPrefix = null;
            if (keyIn) {
                if (!body.skipConnectionTest) {
                    const test = await this.openaiTest.testConnection({ openaiApiKey: keyIn });
                    if (!test.success) {
                        throw new common_1.BadRequestException(test.message || 'OpenAI connection test failed.');
                    }
                }
                const e = this.encryption.encryptToStorage(keyIn);
                if (!e)
                    throw new common_1.BadRequestException('Could not encrypt OpenAI API key.');
                enc = e;
                keyLast4 = last4(keyIn);
                keyPrefix = openaiKeyPrefixHint(keyIn);
            }
            else {
                const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
                if (!row?.openaiApiKeyEnc) {
                    throw new common_1.BadRequestException('API key is required (no existing workspace key on file).');
                }
                enc = row.openaiApiKeyEnc;
                keyLast4 = row.openaiKeyLast4;
                keyPrefix = row.openaiKeyPrefix ?? null;
                if (!body.skipConnectionTest) {
                    const decrypted = this.encryption.decryptFromStorage(enc);
                    if (!decrypted?.trim()) {
                        throw new common_1.BadRequestException('Could not read existing OpenAI key; re-enter your API key.');
                    }
                    const test = await this.openaiTest.testConnection({ openaiApiKey: decrypted });
                    if (!test.success) {
                        throw new common_1.BadRequestException(test.message || 'OpenAI connection test failed.');
                    }
                }
            }
            try {
                await this.prisma.tenantIntegration.upsert({
                    where: { tenantId },
                    create: {
                        tenantId,
                        openaiApiKeyEnc: enc,
                        openaiKeyLast4: keyLast4,
                        openaiKeyPrefix: keyPrefix,
                        openaiLastTestOk: true,
                        openaiLastTestAt: now,
                    },
                    update: {
                        openaiApiKeyEnc: enc,
                        ...(keyLast4 ? { openaiKeyLast4: keyLast4 } : {}),
                        ...(keyPrefix ? { openaiKeyPrefix: keyPrefix } : {}),
                        openaiLastTestOk: true,
                        openaiLastTestAt: now,
                    },
                });
            }
            catch (e) {
                if (this.isSchemaDriftError(e)) {
                    await this.prisma.$executeRawUnsafe(`INSERT INTO "TenantIntegration" ("id","tenantId","openaiApiKeyEnc","openaiKeyLast4","openaiLastTestOk","openaiLastTestAt","createdAt","updatedAt")
             VALUES ($1, $2, $3, $4, true, $5, NOW(), NOW())
             ON CONFLICT ("tenantId")
             DO UPDATE SET
               "openaiApiKeyEnc" = EXCLUDED."openaiApiKeyEnc",
               "openaiKeyLast4" = EXCLUDED."openaiKeyLast4",
               "openaiLastTestOk" = true,
               "openaiLastTestAt" = EXCLUDED."openaiLastTestAt",
               "updatedAt" = NOW()`, (0, crypto_1.randomUUID)(), tenantId, enc, keyLast4, now);
                }
                else {
                    throw e;
                }
            }
            const verify = await this.prisma.tenantIntegration.findUnique({
                where: { tenantId },
                select: { openaiApiKeyEnc: true },
            });
            const roundTrip = verify?.openaiApiKeyEnc
                ? this.encryption.decryptFromStorage(verify.openaiApiKeyEnc)?.trim()
                : null;
            const keyPresent = Boolean(roundTrip);
            if (!keyPresent) {
                throw new common_1.BadRequestException('OpenAI key was saved but could not be verified (decrypt failed).');
            }
            this.log.log(JSON.stringify({
                event: 'tenant_integration_save',
                provider: 'openai',
                tenantId,
                agentId: null,
                fieldsUpdated: ['openaiApiKeyEnc', 'openaiKeyLast4', 'openaiKeyPrefix', 'openaiLastTestOk', 'openaiLastTestAt'],
                voiceProvider: null,
                voiceIdPresent: null,
                openaiKeyPresent: true,
                elevenLabsKeyPresent: null,
                keyPresent,
            }));
            this.audit('save', 'openai', tenantId, true);
            return { ok: true, keyPresent: true };
        }
        catch (e) {
            this.audit('save', 'openai', tenantId, false, e);
            this.mapIntegrationError('openai', e);
        }
    }
    async testElevenlabs(tenantId, body) {
        try {
            const hasApiKey = Boolean(body.apiKey?.trim());
            const voiceId = body.voiceId?.trim() || undefined;
            const model = body.model?.trim() || undefined;
            const apiKeyLength = body.apiKey?.trim().length ?? 0;
            this.log.log(JSON.stringify({
                event: 'tenant_integration_elevenlabs',
                operation: 'test',
                provider: 'elevenlabs',
                tenantId,
                hasApiKey,
                apiKeyLength,
                hasVoiceId: Boolean(voiceId),
                voiceIdLength: voiceId?.length ?? 0,
                model: model ?? null,
            }));
            let key = body.apiKey?.trim();
            if (!key) {
                const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
                if (!row?.elevenlabsApiKeyEnc) {
                    throw new common_1.BadRequestException('ElevenLabs API key is required.');
                }
                if (!this.encryption.isAvailable()) {
                    throw new common_1.BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
                }
                const dec = this.encryption.decryptFromStorage(row.elevenlabsApiKeyEnc);
                if (!dec?.trim())
                    throw new common_1.BadRequestException('Could not read saved ElevenLabs key. Re-enter API key.');
                key = dec.trim();
            }
            const r = await this.elevenlabsTest.testConnection({
                elevenlabsApiKey: key,
                voiceId,
                source: 'test',
                tenantId,
            });
            this.audit('test', 'elevenlabs', tenantId, r.success, r.success ? undefined : r.message);
            return { success: r.success, message: r.message, warnings: r.warnings };
        }
        catch (e) {
            this.audit('test', 'elevenlabs', tenantId, false, e);
            this.mapIntegrationError('elevenlabs', e);
        }
    }
    async saveElevenlabs(tenantId, body) {
        try {
            this.log.log(JSON.stringify({
                event: 'tenant_integration_elevenlabs',
                operation: 'save',
                provider: 'elevenlabs',
                tenantId,
                hasApiKey: Boolean(body.apiKey?.trim()),
                apiKeyLength: body.apiKey?.trim().length ?? 0,
                hasVoiceId: Boolean(body.defaultVoiceId?.trim()),
                voiceIdLength: body.defaultVoiceId?.trim().length ?? 0,
                model: body.defaultModel?.trim() || null,
            }));
            if (!this.encryption.isAvailable()) {
                throw new common_1.BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
            }
            const keyIn = body.apiKey?.trim();
            const voiceId = body.defaultVoiceId?.trim() || null;
            const model = body.defaultModel?.trim() || null;
            if (voiceId && voiceId.length > 200) {
                throw new common_1.BadRequestException('Default voice ID is too long.');
            }
            let enc;
            let keyLast4;
            if (keyIn) {
                if (!body.skipConnectionTest) {
                    const test = await this.elevenlabsTest.testConnection({
                        elevenlabsApiKey: keyIn,
                        voiceId: voiceId ?? undefined,
                        source: 'save',
                        tenantId,
                    });
                    if (!test.success)
                        throw new common_1.BadRequestException(test.message || 'ElevenLabs connection test failed.');
                }
                const e = this.encryption.encryptToStorage(keyIn);
                if (!e)
                    throw new common_1.BadRequestException('Could not encrypt ElevenLabs API key.');
                enc = e;
                keyLast4 = last4(keyIn);
            }
            else {
                const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
                if (!row?.elevenlabsApiKeyEnc) {
                    throw new common_1.BadRequestException('ElevenLabs API key is required (no existing workspace key on file).');
                }
                enc = row.elevenlabsApiKeyEnc;
                keyLast4 = row.elevenlabsKeyLast4;
                if (!body.skipConnectionTest) {
                    const dec = this.encryption.decryptFromStorage(enc);
                    if (!dec?.trim())
                        throw new common_1.BadRequestException('Could not read existing ElevenLabs key; re-enter API key.');
                    const test = await this.elevenlabsTest.testConnection({
                        elevenlabsApiKey: dec.trim(),
                        voiceId: voiceId ?? row.elevenlabsDefaultVoiceId ?? undefined,
                        source: 'save',
                        tenantId,
                    });
                    if (!test.success)
                        throw new common_1.BadRequestException(test.message || 'ElevenLabs connection test failed.');
                }
            }
            const now = new Date();
            await this.prisma.tenantIntegration.upsert({
                where: { tenantId },
                create: {
                    tenantId,
                    elevenlabsApiKeyEnc: enc,
                    elevenlabsKeyLast4: keyLast4,
                    elevenlabsDefaultVoiceId: voiceId,
                    elevenlabsDefaultModel: model,
                    elevenlabsLastTestOk: true,
                    elevenlabsLastTestAt: now,
                },
                update: {
                    elevenlabsApiKeyEnc: enc,
                    ...(keyLast4 ? { elevenlabsKeyLast4: keyLast4 } : {}),
                    elevenlabsDefaultVoiceId: voiceId,
                    elevenlabsDefaultModel: model,
                    elevenlabsLastTestOk: true,
                    elevenlabsLastTestAt: now,
                },
            });
            this.log.log(JSON.stringify({
                event: 'tenant_integration_save',
                provider: 'elevenlabs',
                tenantId,
                agentId: null,
                fieldsUpdated: [
                    'elevenlabsApiKeyEnc',
                    'elevenlabsDefaultVoiceId',
                    'elevenlabsDefaultModel',
                    'elevenlabsLastTestOk',
                    'elevenlabsLastTestAt',
                ],
                voiceProvider: 'elevenlabs',
                voiceIdPresent: Boolean(voiceId),
                openaiKeyPresent: null,
                elevenLabsKeyPresent: true,
            }));
            this.audit('save', 'elevenlabs', tenantId, true);
            return { ok: true, keyPresent: true };
        }
        catch (e) {
            this.audit('save', 'elevenlabs', tenantId, false, e);
            this.mapIntegrationError('elevenlabs', e);
        }
    }
    async testEmail(tenantId, body) {
        this.log.log(JSON.stringify({ event: 'tenant_integration', op: 'test', provider: 'email', tenantId }));
        const { fromEmail, testRecipientEmail, fromName } = body;
        const apiKey = await this.resolveResendApiKeyForTest(tenantId, body.apiKey);
        const from = (0, resend_api_util_1.formatResendFromAddress)(fromEmail, fromName);
        try {
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from,
                    to: [testRecipientEmail],
                    subject: 'Resend connection test',
                    html: '<p>This is a test email confirming your Resend integration is working.</p>',
                    text: 'This is a test email confirming your Resend integration is working.',
                }),
            });
            const bodyText = await response.text();
            let json = null;
            try {
                json = bodyText ? JSON.parse(bodyText) : null;
            }
            catch {
                json = null;
            }
            if (!response.ok) {
                const message = (0, resend_api_util_1.parseResendApiErrorMessage)(response.status, bodyText, json);
                await this.recordEmailTestResult(tenantId, false);
                const out = { success: false, message };
                this.audit('test', 'email', tenantId, false, message);
                return out;
            }
            const testedAt = await this.recordEmailTestResult(tenantId, true);
            const out = {
                success: true,
                message: `Test email sent to ${testRecipientEmail}.`,
                testedAt: testedAt.toISOString(),
            };
            this.audit('test', 'email', tenantId, true);
            return out;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await this.recordEmailTestResult(tenantId, false);
            const out = { success: false, message: `Resend check failed: ${msg}` };
            this.audit('test', 'email', tenantId, false, msg);
            return out;
        }
    }
    async resolveResendApiKeyForTest(tenantId, apiKeyIn) {
        const trimmed = apiKeyIn?.trim();
        if (trimmed)
            return trimmed;
        const row = await this.prisma.tenantIntegration.findUnique({
            where: { tenantId },
            select: { resendApiKeyEnc: true },
        });
        if (!row?.resendApiKeyEnc) {
            throw new common_1.BadRequestException('Resend API key is required. Enter your key or save workspace credentials first.');
        }
        const decrypted = this.encryption.decryptFromStorage(row.resendApiKeyEnc);
        if (!decrypted?.trim()) {
            throw new common_1.BadRequestException('Could not read saved Resend key; re-enter your API key.');
        }
        return decrypted.trim();
    }
    async recordEmailTestResult(tenantId, ok) {
        const testedAt = new Date();
        await this.prisma.tenantIntegration.updateMany({
            where: { tenantId },
            data: { emailLastTestOk: ok, emailLastTestAt: testedAt },
        });
        return testedAt;
    }
    async saveEmail(tenantId, body) {
        try {
            if (!this.encryption.isAvailable()) {
                throw new common_1.BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
            }
            const apiKeyIn = body.apiKey;
            const fromEmail = body.fromEmail;
            let enc;
            let keyLast4;
            if (apiKeyIn) {
                const e = this.encryption.encryptToStorage(apiKeyIn);
                if (!e)
                    throw new common_1.BadRequestException('Could not encrypt Resend API key.');
                enc = e;
                keyLast4 = last4(apiKeyIn);
            }
            else {
                const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
                if (!row?.resendApiKeyEnc) {
                    throw new common_1.BadRequestException('Resend API key is required (no existing workspace key on file).');
                }
                enc = row.resendApiKeyEnc;
                keyLast4 = row.resendKeyLast4;
            }
            await this.prisma.tenantIntegration.upsert({
                where: { tenantId },
                create: {
                    tenantId,
                    resendApiKeyEnc: enc,
                    resendKeyLast4: keyLast4,
                    resendFromEmail: fromEmail,
                },
                update: {
                    resendApiKeyEnc: enc,
                    ...(keyLast4 ? { resendKeyLast4: keyLast4 } : {}),
                    resendFromEmail: fromEmail,
                },
            });
            this.audit('save', 'email', tenantId, true);
            return { ok: true };
        }
        catch (e) {
            this.audit('save', 'email', tenantId, false, e);
            throw e;
        }
    }
};
exports.TenantIntegrationsService = TenantIntegrationsService;
exports.TenantIntegrationsService = TenantIntegrationsService = TenantIntegrationsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService,
        shopify_connection_test_service_1.ShopifyConnectionTestService,
        twilio_connection_test_service_1.TwilioConnectionTestService,
        openai_connection_test_service_1.OpenAIConnectionTestService,
        elevenlabs_connection_test_service_1.ElevenLabsConnectionTestService])
], TenantIntegrationsService);
//# sourceMappingURL=tenant-integrations.service.js.map