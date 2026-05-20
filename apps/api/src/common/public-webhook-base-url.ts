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
