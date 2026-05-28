/**
 * PUBLIC_WEBHOOK_BASE_URL must be the public HTTPS origin (scheme + host, optional port).
 * Paths such as `/api/twilio/...` are appended in code.
 * Strips a mistaken trailing `/api` so URLs are not doubled to `/api/api/...`.
 */
export function normalizePublicWebhookBaseUrl(raw: string | undefined | null): string {
  let s = (raw ?? '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(s) && /\/api$/i.test(s)) {
    s = s.slice(0, -4).replace(/\/+$/, '');
  }
  return s;
}

const BLOCKED_HOST_PATTERNS = [
  /(^|\.)localhost$/i,
  /^127\.0\.0\.1$/i,
  /^0\.0\.0\.0$/i,
  /\.local$/i,
  /ngrok/i,
  /localtunnel/i,
  /example/i,
];

export function validatePublicWebhookBaseUrl(raw: string | undefined | null): {
  ok: boolean;
  normalized: string;
  reason?: 'missing' | 'invalid_url' | 'not_https' | 'blocked_host';
  host?: string;
} {
  const normalized = normalizePublicWebhookBaseUrl(raw);
  if (!normalized) return { ok: false, normalized, reason: 'missing' };
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, normalized, reason: 'invalid_url' };
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:') {
    return { ok: false, normalized, reason: 'not_https', host };
  }
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: false, normalized, reason: 'blocked_host', host };
  }
  return { ok: true, normalized, host };
}
