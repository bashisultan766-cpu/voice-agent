/**
 * Base URL for Next.js Route Handlers (server) to call the Nest API.
 * Use INTERNAL_API_URL when the browser-facing NEXT_PUBLIC_API_URL is wrong for the server
 * (e.g. Docker hostname `http://api:3001` does not resolve on the host during `next dev`).
 *
 * Node's fetch often resolves `localhost` to IPv6 first; Nest may only listen on IPv4, which
 * yields ECONNREFUSED on Windows. Force IPv4 loopback for hostname `localhost`.
 */
function normalizeServerApiBaseUrl(url: string): string {
  const trimmed = url.replace(/\/$/, '');
  try {
    const u = new URL(trimmed);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.href.replace(/\/$/, '');
  } catch {
    return trimmed;
  }
}

/** True when URL looks like the Next.js dev server, not the Nest API (common .env mistake). */
function looksLikeNextDevApp(url: string): boolean {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    return local && port === '3000';
  } catch {
    return false;
  }
}

export function getServerApiBaseUrl(): string {
  const internal = process.env.INTERNAL_API_URL?.trim();
  if (internal) return normalizeServerApiBaseUrl(internal);
  const pub = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (pub) {
    const normalized = normalizeServerApiBaseUrl(pub);
    if (looksLikeNextDevApp(normalized)) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[web] NEXT_PUBLIC_API_URL is set to port 3000 (this app). Server-side calls will use http://127.0.0.1:3001 for the API. Fix apps/web/.env.local — see .env.example.',
        );
      }
      return 'http://127.0.0.1:3001';
    }
    return normalized;
  }
  return 'http://127.0.0.1:3001';
}
