import { parseApiErrorMessage } from '@/lib/api/error-message';
import { getAuthenticatedHeaders } from '@/lib/api/authenticated-fetch';

export type TenantIntegrationSummary = {
  shopify: {
    configured: boolean;
    shopDomain: string | null;
    /** Non-secret hint e.g. shpat_****abcd */
    tokenMasked: string | null;
    lastTestOk: boolean | null;
    lastTestAt: string | null;
  };
  twilio: {
    configured: boolean;
    accountSidLast4: string | null;
    authTokenMasked: string | null;
    phoneNumber: string | null;
    lastTestOk: boolean | null;
    lastTestAt: string | null;
  };
  openai: {
    configured: boolean;
    keyMasked: string | null;
    lastTestOk: boolean | null;
    lastTestAt: string | null;
  };
  elevenlabs: {
    configured: boolean;
    keyMasked: string | null;
    defaultVoiceId: string | null;
    defaultModel: string | null;
    lastTestOk: boolean | null;
    lastTestAt: string | null;
  };
  email: {
    configured: boolean;
    fromEmail: string | null;
    keyMasked: string | null;
    lastTestOk: boolean | null;
    lastTestAt: string | null;
  };
};

/** Headers for browser → `/api/tenant-integrations/*` (Bearer + cookie for Nest when nginx proxies /api). */
export function tenantIntegrationHeaders(): Record<string, string> {
  return getAuthenticatedHeaders() as Record<string, string>;
}

export type TwilioSavePayload = {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
};

export type TwilioTestPayload = {
  accountSid: string;
  phoneNumber: string;
  authToken?: string;
};

export async function saveTwilioSettings(payload: TwilioSavePayload): Promise<Response> {
  return fetch('/api/tenant-integrations/twilio', {
    method: 'PUT',
    credentials: 'include',
    headers: tenantIntegrationHeaders(),
    body: JSON.stringify({
      accountSid: payload.accountSid.trim(),
      authToken: payload.authToken.trim(),
      phoneNumber: payload.phoneNumber.trim(),
    }),
  });
}

export async function testTwilioSettings(payload: TwilioTestPayload): Promise<Response> {
  const authToken = payload.authToken?.trim();
  return fetch('/api/tenant-integrations/twilio/test', {
    method: 'POST',
    credentials: 'include',
    headers: tenantIntegrationHeaders(),
    body: JSON.stringify({
      accountSid: payload.accountSid.trim(),
      phoneNumber: payload.phoneNumber.trim(),
      ...(authToken ? { authToken } : {}),
    }),
  });
}

export type IntegrationTestPayload = {
  success: boolean;
  message: string;
  warnings?: string[];
};

/** Parse Nest test endpoint body (HTTP 200, may still be success: false). */
export function parseIntegrationTestJson(text: string): IntegrationTestPayload | null {
  try {
    const j = JSON.parse(text) as {
      success?: unknown;
      message?: unknown;
      warnings?: unknown;
    };
    if (typeof j.success !== 'boolean' || typeof j.message !== 'string') return null;
    const warnings = Array.isArray(j.warnings)
      ? j.warnings.filter((w): w is string => typeof w === 'string')
      : undefined;
    return { success: j.success, message: j.message, warnings };
  } catch {
    return null;
  }
}

/**
 * Normalize shop domain for integration API: trim, strip https://, drop path/query (admin URLs).
 * Returns hostname only, lowercase (e.g. sureshotbooks-com.myshopify.com).
 */
export function normalizeShopifyIntegrationDomainInput(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  let s = t.replace(/^https?:\/\//i, '');
  const noPath = s.split('/')[0] ?? '';
  const host = (noPath.split('?')[0] ?? '').trim().toLowerCase();
  return host;
}

/** True if the string is only masking bullets / asterisks — do not send as a real token. */
export function looksLikeMaskedSecretOnly(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  if (/^[\u2022\u00B7\u2219•·\*\u25CF●○◦\s]+$/.test(t)) return true;
  if (/^shpat_[•·\*\s]+$/i.test(t)) return true;
  return false;
}

/** UTC display — avoids locale hydration mismatches. */
export function formatIntegrationLastTested(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export async function getTenantIntegrationSummary(): Promise<TenantIntegrationSummary> {
  const res = await fetch('/api/tenant-integrations', {
    credentials: 'include',
    cache: 'no-store',
    headers: { ...tenantIntegrationHeaders() },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const msg = parseApiErrorMessage(t, res.status);
    if (/Database migration required|schema is out of date/i.test(msg)) {
      throw new Error('Database migration required. Run pnpm --filter api exec prisma migrate dev.');
    }
    throw new Error(msg || `Failed to load integrations (${res.status})`);
  }
  const raw = (await res.json()) as Partial<TenantIntegrationSummary>;
  return {
    shopify: {
      configured: Boolean(raw.shopify?.configured),
      shopDomain: raw.shopify?.shopDomain ?? null,
      tokenMasked: raw.shopify?.tokenMasked ?? null,
      lastTestOk: raw.shopify?.lastTestOk ?? null,
      lastTestAt: raw.shopify?.lastTestAt ?? null,
    },
    twilio: {
      configured: Boolean(raw.twilio?.configured),
      accountSidLast4: raw.twilio?.accountSidLast4 ?? null,
      authTokenMasked: raw.twilio?.authTokenMasked ?? null,
      phoneNumber: raw.twilio?.phoneNumber ?? null,
      lastTestOk: raw.twilio?.lastTestOk ?? null,
      lastTestAt: raw.twilio?.lastTestAt ?? null,
    },
    openai: {
      configured: Boolean(raw.openai?.configured),
      keyMasked: raw.openai?.keyMasked ?? null,
      lastTestOk: raw.openai?.lastTestOk ?? null,
      lastTestAt: raw.openai?.lastTestAt ?? null,
    },
    elevenlabs: {
      configured: Boolean(raw.elevenlabs?.configured),
      keyMasked: raw.elevenlabs?.keyMasked ?? null,
      defaultVoiceId: raw.elevenlabs?.defaultVoiceId ?? null,
      defaultModel: raw.elevenlabs?.defaultModel ?? null,
      lastTestOk: raw.elevenlabs?.lastTestOk ?? null,
      lastTestAt: raw.elevenlabs?.lastTestAt ?? null,
    },
    email: {
      configured: Boolean(raw.email?.configured),
      fromEmail: raw.email?.fromEmail ?? null,
      keyMasked: raw.email?.keyMasked ?? null,
      lastTestOk: raw.email?.lastTestOk ?? null,
      lastTestAt: raw.email?.lastTestAt ?? null,
    },
  };
}
