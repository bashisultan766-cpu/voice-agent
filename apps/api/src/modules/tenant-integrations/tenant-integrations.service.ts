import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from '../../common/encryption.service';
import { ShopifyConnectionTestService } from '../agents/connection-test/shopify-connection-test.service';
import { TwilioConnectionTestService } from '../agents/connection-test/twilio-connection-test.service';
import { OpenAIConnectionTestService } from '../agents/connection-test/openai-connection-test.service';
import { ElevenLabsConnectionTestService } from '../agents/connection-test/elevenlabs-connection-test.service';
import { normalizeShopifyDomain, normalizePhoneNumber } from '@bookstore-voice-agents/types';
import { formatResendFromAddress, parseResendApiErrorMessage } from './resend-api.util';
import { validatePublicWebhookBaseUrl } from '../../common/public-webhook-base-url';

function last4(value: string | null | undefined): string | null {
  const s = value?.trim();
  if (!s || s.length < 4) return null;
  return s.slice(-4);
}

function maskKindHint(kind: 'shopify' | 'openai' | 'resend' | 'elevenlabs', last4: string | null | undefined): string | null {
  const s = last4?.trim();
  if (!s || s.length < 4) return null;
  if (kind === 'shopify') return `shpat_****${s}`;
  if (kind === 'openai') return `sk-****${s}`;
  if (kind === 'elevenlabs') return `xi_****${s}`;
  return `re_****${s}`;
}

function openaiKeyPrefixHint(value: string | null | undefined): string | null {
  const key = value?.trim().toLowerCase();
  if (!key) return null;
  if (key.startsWith('sk-proj-')) return 'sk-proj-';
  if (key.startsWith('sk-')) return 'sk-';
  return null;
}

function isPlausibleTwilioAccountSid(sid: string): boolean {
  return /^AC[a-z0-9]{32}$/i.test(sid.trim());
}

function isE164Phone(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.trim());
}

function sanitizeLogError(err: unknown): string {
  if (err instanceof BadRequestException) {
    const r = err.getResponse();
    if (typeof r === 'string') return r.slice(0, 240);
    if (r && typeof r === 'object' && 'message' in r) {
      const m = (r as { message?: unknown }).message;
      if (typeof m === 'string') return m.slice(0, 240);
    }
  }
  if (err instanceof Error) return err.message.slice(0, 240);
  return String(err).slice(0, 240);
}

function storeSlugFromMyshopifyDomain(domain: string): string {
  const host = normalizeShopifyDomain(domain) || domain.trim().toLowerCase();
  const base = host.replace(/\.myshopify\.com$/i, '') || host;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'store'
  );
}

/** Strip paths/query, https://, ensure *.myshopify.com host. */
function canonicalMyshopifyHostname(input: string): string {
  let s = normalizeShopifyDomain(input) || input.trim().toLowerCase();
  s = s.replace(/\/$/, '');
  const hostOnly = (s.split('/')[0] ?? s).split('?')[0] ?? s;
  let h = hostOnly.trim().toLowerCase();
  if (!h.endsWith('.myshopify.com')) {
    const sub = h.replace(/\.myshopify\.com$/i, '').replace(/^https?:\/\//i, '');
    h = `${sub}.myshopify.com`.toLowerCase();
  }
  return h;
}

function shopifyHostsMatch(a: string, b: string): boolean {
  return canonicalMyshopifyHostname(a) === canonicalMyshopifyHostname(b);
}

/** Empty, whitespace-only, bullet-only, or pasted UI mask — not a real Admin API token. */
function isBogusOrMaskedShopifyAdminToken(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return true;
  const t = raw.trim();
  if (!t) return true;
  if (/^[\u2022\u00B7\u2219•·\*\u25CF●○◦\s]+$/.test(t)) return true;
  if (/^shpat_[•·\*\s]+$/i.test(t)) return true;
  return false;
}

@Injectable()
export class TenantIntegrationsService {
  private readonly log = new Logger(TenantIntegrationsService.name);

  private isSchemaDriftError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      (err.code === 'P2021' || err.code === 'P2022')
    );
  }

  private buildSchemaDriftMessage(provider: string, err: Prisma.PrismaClientKnownRequestError): string {
    const meta = (err.meta ?? {}) as Record<string, unknown>;
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

  private mapIntegrationError(provider: string, err: unknown): never {
    if (err instanceof BadRequestException) throw err;
    if (this.isSchemaDriftError(err)) {
      throw new BadRequestException(this.buildSchemaDriftMessage(provider, err));
    }
    throw err;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    private readonly shopifyTest: ShopifyConnectionTestService,
    private readonly twilioTest: TwilioConnectionTestService,
    private readonly openaiTest: OpenAIConnectionTestService,
    private readonly elevenlabsTest: ElevenLabsConnectionTestService,
  ) {}

  private audit(
    op: 'summary' | 'test' | 'save',
    provider: string,
    tenantId: string,
    ok: boolean,
    err?: unknown,
  ): void {
    const payload = {
      event: 'tenant_integration',
      op,
      provider,
      tenantId,
      ok,
      ...(err != null ? { error: sanitizeLogError(err) } : {}),
    };
    if (ok) this.log.log(JSON.stringify(payload));
    else this.log.warn(JSON.stringify(payload));
  }

  private async getTenantIntegrationRowResilient(tenantId: string): Promise<Record<string, unknown> | null> {
    const columns = (await this.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='TenantIntegration'`,
    )).map((r) => r.column_name);
    if (!columns.length) return null;

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
    ] as const;
    const select = wanted
      .map((name) => (set.has(name) ? `"${name}"` : `NULL AS "${name}"`))
      .join(', ');
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${select} FROM "TenantIntegration" WHERE "tenantId" = $1 LIMIT 1`,
      tenantId,
    );
    return rows[0] ?? null;
  }

  async getSafeSummary(tenantId: string) {
    try {
      const row = await this.getTenantIntegrationRowResilient(tenantId);
      if (!row) {
        return {
          shopify: {
            configured: false,
            shopDomain: null as string | null,
            tokenMasked: null as string | null,
            lastTestOk: null as boolean | null,
            lastTestAt: null as string | null,
          },
          twilio: {
            configured: false,
            accountSidLast4: null as string | null,
            authTokenMasked: null as string | null,
            phoneNumber: null as string | null,
            lastTestOk: null as boolean | null,
            lastTestAt: null as string | null,
          },
          openai: {
            configured: false,
            keyMasked: null as string | null,
            lastTestOk: null as boolean | null,
            lastTestAt: null as string | null,
          },
          elevenlabs: {
            configured: false,
            keyMasked: null as string | null,
            defaultVoiceId: null as string | null,
            defaultModel: null as string | null,
            lastTestOk: null as boolean | null,
            lastTestAt: null as string | null,
          },
          email: {
            configured: false,
            fromEmail: null as string | null,
            keyMasked: null as string | null,
            lastTestOk: null as boolean | null,
            lastTestAt: null as string | null,
          },
        };
      }
      const dateIso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
      const str = (value: unknown): string | null =>
        typeof value === 'string' && value.trim() ? value.trim() : null;
      const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
      const summary = {
        shopify: {
          configured: Boolean(str(row.shopifyShopDomain) && str(row.shopifyAdminTokenEnc)),
          shopDomain: str(row.shopifyShopDomain),
          tokenMasked: maskKindHint('shopify', str(row.shopifyTokenLast4)),
          lastTestOk: bool(row.shopifyLastTestOk),
          lastTestAt: dateIso(row.shopifyLastTestAt),
        },
        twilio: {
          configured: Boolean(
            str(row.twilioAccountSid) &&
              str(row.twilioAuthTokenEnc) &&
              str(row.twilioPhoneNumber),
          ),
          accountSidLast4: last4(str(row.twilioAccountSid)),
          authTokenMasked: str(row.twilioAuthTokenEnc) ? 'tw_****saved' : null,
          phoneNumber: str(row.twilioPhoneNumber),
          lastTestOk: bool(row.twilioLastTestOk),
          lastTestAt: dateIso(row.twilioLastTestAt),
        },
        openai: {
          configured: Boolean(str(row.openaiApiKeyEnc)),
          keyMasked: (() => {
            const l4 = str(row.openaiKeyLast4);
            if (!l4 || l4.length < 4) return null;
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
      this.log.log(
        JSON.stringify({
          event: 'tenant_integration.load',
          tenantId,
          providers: {
            shopify: { saved: summary.shopify.configured, source: summary.shopify.configured ? 'workspace' : 'missing' },
            twilio: { saved: summary.twilio.configured, source: summary.twilio.configured ? 'workspace' : 'missing' },
            openai: { saved: summary.openai.configured, source: summary.openai.configured ? 'workspace' : 'missing' },
            elevenlabs: { saved: summary.elevenlabs.configured, source: summary.elevenlabs.configured ? 'workspace' : 'missing' },
            resend: { saved: summary.email.configured, source: summary.email.configured ? 'workspace' : 'missing' },
          },
        }),
      );
      return summary;
    } catch (e) {
      this.audit('summary', 'summary', tenantId, false, e);
      this.mapIntegrationError('summary', e);
    }
  }

  async testShopify(
    tenantId: string,
    body: { shopDomain: string; accessToken?: string },
  ) {
    const hostRaw = body.shopDomain?.trim();
    if (!hostRaw) {
      throw new BadRequestException('Shop domain is required.');
    }
    const domain = canonicalMyshopifyHostname(hostRaw);
    if (!domain.endsWith('.myshopify.com')) {
      throw new BadRequestException('Use your store myshopify.com hostname (e.g. your-store.myshopify.com).');
    }

    let incoming = body.accessToken?.trim();
    if (incoming && isBogusOrMaskedShopifyAdminToken(incoming)) {
      incoming = undefined;
    }

    let token: string;
    if (incoming) {
      token = incoming;
    } else {
      const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
      if (!row?.shopifyAdminTokenEnc || !row.shopifyShopDomain?.trim()) {
        throw new BadRequestException('Shop domain and access token are required.');
      }
      if (!shopifyHostsMatch(row.shopifyShopDomain, domain)) {
        throw new BadRequestException(
          'Enter a new access token to test this shop domain, or use the domain that matches your saved connection.',
        );
      }
      if (!this.encryption.isAvailable()) {
        throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
      }
      const dec = this.encryption.decryptFromStorage(row.shopifyAdminTokenEnc);
      if (!dec?.trim()) {
        throw new BadRequestException('Could not read saved token. Enter a new Admin API access token.');
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

  async saveShopify(
    tenantId: string,
    body: { shopDomain: string; accessToken?: string; skipConnectionTest?: boolean },
  ) {
    try {
      if (!this.encryption.isAvailable()) {
        throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
      }
      const hostRaw = body.shopDomain?.trim();
      if (!hostRaw) {
        throw new BadRequestException('Shop domain is required.');
      }
      const domain = canonicalMyshopifyHostname(hostRaw);
      if (!domain.endsWith('.myshopify.com')) {
        throw new BadRequestException('Use your store myshopify.com hostname (e.g. your-store.myshopify.com).');
      }

      let incoming = body.accessToken?.trim();
      if (incoming && isBogusOrMaskedShopifyAdminToken(incoming)) {
        incoming = undefined;
      }

      let tokenPlain: string;
      let enc: string;
      let tokLast4: string | null;

      if (incoming) {
        tokenPlain = incoming;
        const encNew = this.encryption.encryptToStorage(tokenPlain);
        if (!encNew) throw new BadRequestException('Could not encrypt Shopify token.');
        enc = encNew;
        tokLast4 = last4(tokenPlain);
      } else {
        const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
        if (!row?.shopifyAdminTokenEnc) {
          throw new BadRequestException('Shop domain and access token are required.');
        }
        if (!shopifyHostsMatch(row.shopifyShopDomain || '', domain)) {
          throw new BadRequestException(
            'Enter a new Admin API access token when changing shop domain.',
          );
        }
        const dec = this.encryption.decryptFromStorage(row.shopifyAdminTokenEnc);
        if (!dec?.trim()) {
          throw new BadRequestException('Could not read saved token. Enter a new Admin API access token.');
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
          throw new BadRequestException(test.message || 'Shopify connection test failed.');
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
    } catch (e) {
      this.audit('save', 'shopify', tenantId, false, e);
      throw e;
    }
  }

  async testTwilio(
    tenantId: string,
    body: { accountSid: string; authToken?: string; phoneNumber?: string },
  ) {
    this.log.log(
      JSON.stringify({
        op: 'test',
        provider: 'twilio',
        tenantId,
        bodyKeys: Object.keys((body ?? {}) as Record<string, unknown>),
        hasAccountSid: Boolean(body?.accountSid?.trim()),
        hasAuthToken: Boolean(body?.authToken?.trim()),
        hasPhoneNumber: Boolean(body?.phoneNumber?.trim()),
      }),
    );
    const sidIn = body.accountSid?.trim() ?? '';
    if (sidIn && !isPlausibleTwilioAccountSid(sidIn)) {
      const out = {
        success: false,
        message: 'Account SID should look like AC followed by 32 letters/numbers.',
      };
      this.audit('test', 'twilio', tenantId, false, out.message);
      return out;
    }
    const phoneRaw = body.phoneNumber?.trim();
    const phone = phoneRaw ? normalizePhoneNumber(phoneRaw) : undefined;
    if (phone && !isE164Phone(phone)) {
      const out = {
        success: false,
        message: 'Phone number should be in E.164 format (e.g. +15551234567).',
      };
      this.audit('test', 'twilio', tenantId, false, out.message);
      return out;
    }
    let authToken = body.authToken?.trim();
    if (!authToken) {
      if (!this.encryption.isAvailable()) {
        throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
      }
      const row = await this.prisma.tenantIntegration.findUnique({
        where: { tenantId },
        select: { twilioAccountSid: true, twilioAuthTokenEnc: true },
      });
      if (!row?.twilioAuthTokenEnc) {
        throw new BadRequestException('Auth token is required on first save/test.');
      }
      if (!row.twilioAccountSid?.trim() || row.twilioAccountSid.trim() !== sidIn) {
        throw new BadRequestException('Enter auth token when changing Account SID.');
      }
      const dec = this.encryption.decryptFromStorage(row.twilioAuthTokenEnc);
      if (!dec?.trim()) {
        throw new BadRequestException('Could not read saved auth token. Enter a new token.');
      }
      authToken = dec.trim();
    }
    const r = await this.twilioTest.testConnection({
      twilioAccountSid: sidIn,
      twilioAuthToken: authToken,
    });
    if (!r.success) {
      this.audit('test', 'twilio', tenantId, false, r.message);
      return r;
    }
    if (phone) {
      const pSid = await this.twilioTest.resolveIncomingPhoneSid({
        twilioAccountSid: sidIn,
        twilioAuthToken: authToken,
        twilioPhoneNumber: phone,
      });
      if (!pSid) {
        const out = {
          success: false,
          message:
            'Account credentials are valid, but the phone number was not found on this Twilio account.',
        };
        this.audit('test', 'twilio', tenantId, false, out.message);
        return out;
      }
    }
    this.audit('test', 'twilio', tenantId, true);
    return r;
  }

  async saveTwilio(
    tenantId: string,
    body: {
      accountSid: string;
      authToken?: string;
      phoneNumber: string;
      skipConnectionTest?: boolean;
    },
  ) {
    try {
      const existing = await this.prisma.tenantIntegration.findUnique({
        where: { tenantId },
        select: {
          twilioAccountSid: true,
          twilioAuthTokenEnc: true,
          twilioPhoneSid: true,
        },
      });
      const savedTokenExistsBefore = Boolean(existing?.twilioAuthTokenEnc);
      this.log.log(
        JSON.stringify({
          op: 'save',
          provider: 'twilio',
          tenantId,
          bodyKeys: Object.keys((body ?? {}) as Record<string, unknown>),
          hasAccountSid: Boolean(body?.accountSid?.trim()),
          hasAuthTokenInput: Boolean(body?.authToken?.trim()),
          hasPhoneNumber: Boolean(body?.phoneNumber?.trim()),
          savedTokenExistsBefore,
        }),
      );
      if (!this.encryption.isAvailable()) {
        throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
      }
      const accountSid = body.accountSid?.trim();
      const phoneNumberRaw = body.phoneNumber?.trim();
      if (!accountSid || !phoneNumberRaw) {
        throw new BadRequestException('Account SID and phone number are required.');
      }
      const authTokenIncoming = body.authToken?.trim();
      const phoneNumber = normalizePhoneNumber(phoneNumberRaw);
      if (!isPlausibleTwilioAccountSid(accountSid)) {
        throw new BadRequestException('Account SID should look like AC followed by 32 letters/numbers.');
      }
      if (!isE164Phone(phoneNumber)) {
        throw new BadRequestException('Phone number must be in E.164 format (e.g. +15551234567).');
      }
      let authToken = authTokenIncoming;
      let enc = '';
      if (authToken) {
        const encrypted = this.encryption.encryptToStorage(authToken);
        if (!encrypted) throw new BadRequestException('Could not encrypt Twilio auth token.');
        enc = encrypted;
      } else {
        if (!existing?.twilioAuthTokenEnc) {
          throw new BadRequestException('Auth token is required on first save.');
        }
        if (!existing.twilioAccountSid?.trim() || existing.twilioAccountSid.trim() !== accountSid) {
          throw new BadRequestException('Auth token is required when changing Account SID.');
        }
        const dec = this.encryption.decryptFromStorage(existing.twilioAuthTokenEnc);
        if (!dec?.trim()) {
          throw new BadRequestException('Could not read saved auth token. Enter a new token.');
        }
        authToken = dec.trim();
        enc = existing.twilioAuthTokenEnc;
      }

      if (!body.skipConnectionTest) {
        const test = await this.twilioTest.testConnection({
          twilioAccountSid: accountSid,
          twilioAuthToken: authToken,
        });
        if (!test.success) {
          throw new BadRequestException(test.message || 'Twilio connection test failed.');
        }
        const phoneSid = await this.twilioTest.resolveIncomingPhoneSid({
          twilioAccountSid: accountSid,
          twilioAuthToken: authToken,
          twilioPhoneNumber: phoneNumber,
        });
        if (!phoneSid) {
          throw new BadRequestException(
            'Phone number not found on this Twilio account. Check E.164 format (+1…).',
          );
        }
      }

      const phoneSid =
        (await this.twilioTest.resolveIncomingPhoneSid({
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
      const verifyAfter = await this.prisma.tenantIntegration.findUnique({
        where: { tenantId },
        select: { twilioAuthTokenEnc: true },
      });
      this.log.log(
        JSON.stringify({
          event: 'tenant_integration.twilio.save',
          tenantId,
          bodyKeys: Object.keys((body ?? {}) as Record<string, unknown>),
          hasAccountSid: Boolean(accountSid),
          hasAuthTokenInput: Boolean(authTokenIncoming),
          hasPhoneNumber: Boolean(phoneNumber),
          savedTokenExistsBefore,
          savedTokenExistsAfter: Boolean(verifyAfter?.twilioAuthTokenEnc),
        }),
      );

      this.audit('save', 'twilio', tenantId, true);
      return {
        ok: true,
        saved: true,
        phoneNumber,
        authTokenMasked: `tw_****${authToken.slice(-4)}`,
      };
    } catch (e) {
      this.audit('save', 'twilio', tenantId, false, e);
      throw e;
    }
  }

  async configureTwilioWebhook(tenantId: string) {
    const row = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId },
      select: {
        twilioAccountSid: true,
        twilioAuthTokenEnc: true,
        twilioPhoneNumber: true,
        twilioPhoneSid: true,
      },
    });
    const sid = row?.twilioAccountSid?.trim() ?? '';
    const phoneNumber = row?.twilioPhoneNumber?.trim() ?? '';
    if (!sid || !phoneNumber) {
      throw new BadRequestException('Twilio Account SID and phone number must be saved first.');
    }
    if (!row?.twilioAuthTokenEnc) {
      throw new BadRequestException('Twilio auth token is missing. Save credentials first.');
    }
    const authToken = this.encryption.decryptFromStorage(row.twilioAuthTokenEnc)?.trim();
    if (!authToken) {
      throw new BadRequestException('Could not read saved Twilio auth token. Re-save credentials.');
    }
    const baseUrlValidation = validatePublicWebhookBaseUrl(this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL'));
    if (!baseUrlValidation.ok) {
      throw new BadRequestException(
        `PUBLIC_WEBHOOK_BASE_URL must be a public HTTPS URL (no localhost/ngrok/example/localtunnel). reason=${baseUrlValidation.reason ?? 'invalid'}.`,
      );
    }
    const baseUrl = baseUrlValidation.normalized;
    const inboundUrl = `${baseUrl}/api/twilio/voice/inbound`;
    const statusUrl = `${baseUrl}/api/twilio/voice/status`;
    let incomingPhoneSid = row.twilioPhoneSid?.trim() ?? '';
    if (!incomingPhoneSid) {
      incomingPhoneSid =
        (await this.twilioTest.resolveIncomingPhoneSid({
          twilioAccountSid: sid,
          twilioAuthToken: authToken,
          twilioPhoneNumber: phoneNumber,
        })) ?? '';
    }
    if (!incomingPhoneSid) {
      throw new BadRequestException('Phone number was not found in this Twilio account.');
    }
    const result = await this.twilioTest.updateIncomingPhoneNumberWebhook(
      {
        twilioAccountSid: sid,
        twilioAuthToken: authToken,
        twilioPhoneNumber: phoneNumber,
      },
      {
        incomingPhoneSid,
        voiceUrl: inboundUrl,
        statusCallback: statusUrl,
        method: 'POST',
      },
    );
    if (!result.success) throw new BadRequestException(result.message);
    await this.prisma.tenantIntegration.updateMany({
      where: { tenantId },
      data: { twilioPhoneSid: incomingPhoneSid },
    });
    return {
      success: true,
      message: 'Twilio webhook configured.',
      webhook: {
        inboundUrl,
        statusUrl,
        method: 'POST' as const,
      },
      mediaStream: {
        enabled: false,
        wsUrl: null,
      },
    };
  }

  async testOpenai(tenantId: string, body: { apiKey?: string }) {
    let key = body.apiKey?.trim();
    if (!key) {
      if (!this.encryption.isAvailable()) {
        throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
      }
      const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
      if (!row?.openaiApiKeyEnc) {
        throw new BadRequestException('API key is required (no existing workspace key on file).');
      }
      const decrypted = this.encryption.decryptFromStorage(row.openaiApiKeyEnc);
      if (!decrypted?.trim()) {
        throw new BadRequestException('Could not read existing OpenAI key; re-enter your API key.');
      }
      key = decrypted.trim();
    }
    this.log.log(
      JSON.stringify({
        provider: 'openai',
        operation: 'test',
        tenantId,
        hasApiKey: Boolean(key),
        keyLength: key.length,
      }),
    );
    const r = await this.openaiTest.testConnection({ openaiApiKey: key });
    this.audit('test', 'openai', tenantId, r.success, r.success ? undefined : r.message);
    return { success: r.success, message: r.message, warnings: r.warnings };
  }

  async saveOpenai(tenantId: string, body: { apiKey?: string; skipConnectionTest?: boolean }) {
    try {
      if (!this.encryption.isAvailable()) {
        throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
      }
      const keyIn = body.apiKey?.trim();
      const existing = await this.prisma.tenantIntegration.findUnique({
        where: { tenantId },
        select: { openaiApiKeyEnc: true },
      });
      const savedKeyExistsBefore = Boolean(existing?.openaiApiKeyEnc);
      this.log.log(
        JSON.stringify({
          provider: 'openai',
          operation: 'save',
          tenantId,
          bodyKeys: Object.keys((body ?? {}) as Record<string, unknown>),
          hasApiKeyInput: Boolean(keyIn),
          savedKeyExistsBefore,
        }),
      );
      const now = new Date();
      let enc: string;
      let keyLast4: string | null;
      let keyPrefix: string | null = null;

      if (keyIn) {
        if (!body.skipConnectionTest) {
          const test = await this.openaiTest.testConnection({ openaiApiKey: keyIn });
          if (!test.success) {
            throw new BadRequestException(test.message || 'OpenAI connection test failed.');
          }
        }
        const e = this.encryption.encryptToStorage(keyIn);
        if (!e) throw new BadRequestException('Could not encrypt OpenAI API key.');
        enc = e;
        keyLast4 = last4(keyIn);
        keyPrefix = openaiKeyPrefixHint(keyIn);
      } else {
        const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
        if (!row?.openaiApiKeyEnc) {
          throw new BadRequestException('API key is required (no existing workspace key on file).');
        }
        enc = row.openaiApiKeyEnc;
        keyLast4 = row.openaiKeyLast4;
        keyPrefix = row.openaiKeyPrefix ?? null;
        if (!body.skipConnectionTest) {
          const decrypted = this.encryption.decryptFromStorage(enc);
          if (!decrypted?.trim()) {
            throw new BadRequestException('Could not read existing OpenAI key; re-enter your API key.');
          }
          const test = await this.openaiTest.testConnection({ openaiApiKey: decrypted });
          if (!test.success) {
            throw new BadRequestException(test.message || 'OpenAI connection test failed.');
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
      } catch (e) {
        // Backward-compatible fallback when DB has not yet applied openaiKeyPrefix migration.
        if (this.isSchemaDriftError(e)) {
          await this.prisma.$executeRawUnsafe(
            `INSERT INTO "TenantIntegration" ("id","tenantId","openaiApiKeyEnc","openaiKeyLast4","openaiLastTestOk","openaiLastTestAt","createdAt","updatedAt")
             VALUES ($1, $2, $3, $4, true, $5, NOW(), NOW())
             ON CONFLICT ("tenantId")
             DO UPDATE SET
               "openaiApiKeyEnc" = EXCLUDED."openaiApiKeyEnc",
               "openaiKeyLast4" = EXCLUDED."openaiKeyLast4",
               "openaiLastTestOk" = true,
               "openaiLastTestAt" = EXCLUDED."openaiLastTestAt",
               "updatedAt" = NOW()`,
            randomUUID(),
            tenantId,
            enc,
            keyLast4,
            now,
          );
        } else {
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
      this.log.log(
        JSON.stringify({
          event: 'tenant_integration.openai.save',
          tenantId,
          bodyKeys: Object.keys((body ?? {}) as Record<string, unknown>),
          hasApiKeyInput: Boolean(keyIn),
          savedKeyExistsBefore,
          savedKeyExistsAfter: keyPresent,
        }),
      );
      if (!keyPresent) {
        throw new BadRequestException('OpenAI key was saved but could not be verified (decrypt failed).');
      }
      this.log.log(
        JSON.stringify({
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
        }),
      );
      this.audit('save', 'openai', tenantId, true);
      return { ok: true, keyPresent: true };
    } catch (e) {
      this.audit('save', 'openai', tenantId, false, e);
      this.mapIntegrationError('openai', e);
    }
  }

  async testElevenlabs(
    tenantId: string,
    body: { apiKey?: string; voiceId?: string; model?: string },
  ) {
    try {
      const hasApiKey = Boolean(body.apiKey?.trim());
      const voiceId = body.voiceId?.trim() || undefined;
      const model = body.model?.trim() || undefined;
      const apiKeyLength = body.apiKey?.trim().length ?? 0;
      this.log.log(
        JSON.stringify({
          event: 'tenant_integration_elevenlabs',
          operation: 'test',
          provider: 'elevenlabs',
          tenantId,
          hasApiKey,
          apiKeyLength,
          hasVoiceId: Boolean(voiceId),
          voiceIdLength: voiceId?.length ?? 0,
          model: model ?? null,
        }),
      );

      let key = body.apiKey?.trim();
      if (!key) {
        const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
        if (!row?.elevenlabsApiKeyEnc) {
          throw new BadRequestException('ElevenLabs API key is required.');
        }
        if (!this.encryption.isAvailable()) {
          throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
        }
        const dec = this.encryption.decryptFromStorage(row.elevenlabsApiKeyEnc);
        if (!dec?.trim()) throw new BadRequestException('Could not read saved ElevenLabs key. Re-enter API key.');
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
    } catch (e) {
      this.audit('test', 'elevenlabs', tenantId, false, e);
      this.mapIntegrationError('elevenlabs', e);
    }
  }

  async saveElevenlabs(
    tenantId: string,
    body: { apiKey?: string; defaultVoiceId?: string; defaultModel?: string; skipConnectionTest?: boolean },
  ) {
    try {
      this.log.log(
        JSON.stringify({
          event: 'tenant_integration_elevenlabs',
          operation: 'save',
          provider: 'elevenlabs',
          tenantId,
          hasApiKey: Boolean(body.apiKey?.trim()),
          apiKeyLength: body.apiKey?.trim().length ?? 0,
          hasVoiceId: Boolean(body.defaultVoiceId?.trim()),
          voiceIdLength: body.defaultVoiceId?.trim().length ?? 0,
          model: body.defaultModel?.trim() || null,
        }),
      );
      if (!this.encryption.isAvailable()) {
        throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
      }
      const keyIn = body.apiKey?.trim();
      const voiceId = body.defaultVoiceId?.trim() || null;
      const model = body.defaultModel?.trim() || null;
      if (voiceId && voiceId.length > 200) {
        throw new BadRequestException('Default voice ID is too long.');
      }
      let enc: string;
      let keyLast4: string | null;
      if (keyIn) {
        if (!body.skipConnectionTest) {
          const test = await this.elevenlabsTest.testConnection({
            elevenlabsApiKey: keyIn,
            voiceId: voiceId ?? undefined,
            source: 'save',
            tenantId,
          });
          if (!test.success) throw new BadRequestException(test.message || 'ElevenLabs connection test failed.');
        }
        const e = this.encryption.encryptToStorage(keyIn);
        if (!e) throw new BadRequestException('Could not encrypt ElevenLabs API key.');
        enc = e;
        keyLast4 = last4(keyIn);
      } else {
        const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
        if (!row?.elevenlabsApiKeyEnc) {
          throw new BadRequestException('ElevenLabs API key is required (no existing workspace key on file).');
        }
        enc = row.elevenlabsApiKeyEnc;
        keyLast4 = row.elevenlabsKeyLast4;
        if (!body.skipConnectionTest) {
          const dec = this.encryption.decryptFromStorage(enc);
          if (!dec?.trim()) throw new BadRequestException('Could not read existing ElevenLabs key; re-enter API key.');
          const test = await this.elevenlabsTest.testConnection({
            elevenlabsApiKey: dec.trim(),
            voiceId: voiceId ?? row.elevenlabsDefaultVoiceId ?? undefined,
            source: 'save',
            tenantId,
          });
          if (!test.success) throw new BadRequestException(test.message || 'ElevenLabs connection test failed.');
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
      this.log.log(
        JSON.stringify({
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
        }),
      );
      this.audit('save', 'elevenlabs', tenantId, true);
      return { ok: true, keyPresent: true };
    } catch (e) {
      this.audit('save', 'elevenlabs', tenantId, false, e);
      this.mapIntegrationError('elevenlabs', e);
    }
  }

  async testEmail(
    tenantId: string,
    body: { apiKey?: string; fromEmail: string; testRecipientEmail: string; fromName?: string },
  ) {
    this.log.log(
      JSON.stringify({ event: 'tenant_integration', op: 'test', provider: 'email', tenantId }),
    );
    const { fromEmail, testRecipientEmail, fromName } = body;
    const apiKey = await this.resolveResendApiKeyForTest(tenantId, body.apiKey);
    const from = formatResendFromAddress(fromEmail, fromName);
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
      let json: unknown = null;
      try {
        json = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        json = null;
      }
      if (!response.ok) {
        const message = parseResendApiErrorMessage(response.status, bodyText, json);
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.recordEmailTestResult(tenantId, false);
      const out = { success: false, message: `Resend check failed: ${msg}` };
      this.audit('test', 'email', tenantId, false, msg);
      return out;
    }
  }

  private async resolveResendApiKeyForTest(tenantId: string, apiKeyIn?: string): Promise<string> {
    const trimmed = apiKeyIn?.trim();
    if (trimmed) return trimmed;
    const row = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId },
      select: { resendApiKeyEnc: true },
    });
    if (!row?.resendApiKeyEnc) {
      throw new BadRequestException(
        'Resend API key is required. Enter your key or save workspace credentials first.',
      );
    }
    const decrypted = this.encryption.decryptFromStorage(row.resendApiKeyEnc);
    if (!decrypted?.trim()) {
      throw new BadRequestException('Could not read saved Resend key; re-enter your API key.');
    }
    return decrypted.trim();
  }

  /** Persists last test outcome when workspace integration row already exists. */
  private async recordEmailTestResult(tenantId: string, ok: boolean): Promise<Date> {
    const testedAt = new Date();
    await this.prisma.tenantIntegration.updateMany({
      where: { tenantId },
      data: { emailLastTestOk: ok, emailLastTestAt: testedAt },
    });
    return testedAt;
  }

  async saveEmail(tenantId: string, body: { apiKey?: string; fromEmail: string }) {
    try {
      if (!this.encryption.isAvailable()) {
        throw new BadRequestException('Encryption is not configured (ENCRYPTION_KEY).');
      }
      const apiKeyIn = body.apiKey;
      const fromEmail = body.fromEmail;

      let enc: string;
      let keyLast4: string | null;

      if (apiKeyIn) {
        const e = this.encryption.encryptToStorage(apiKeyIn);
        if (!e) throw new BadRequestException('Could not encrypt Resend API key.');
        enc = e;
        keyLast4 = last4(apiKeyIn);
      } else {
        const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
        if (!row?.resendApiKeyEnc) {
          throw new BadRequestException('Resend API key is required (no existing workspace key on file).');
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
    } catch (e) {
      this.audit('save', 'email', tenantId, false, e);
      throw e;
    }
  }
}
