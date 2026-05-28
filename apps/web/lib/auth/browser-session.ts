/** Client-only session helpers: mirrors httpOnly cookie for Bearer on same-origin API fetches. */

export const ACCESS_TOKEN_STORAGE_KEY = 'va_access_token';

const AUTH_HINT_COOKIE = 'va_auth_hint';

export function readStoredAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Extra headers for browser fetch to Next API routes (Authorization wins over stale cookie server-side). */
export function getBearerInit(): Record<string, string> {
  const t = readStoredAccessToken();
  if (!t) return {};
  return { Authorization: `Bearer ${t}` };
}

export function persistClientSession(accessToken: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, accessToken);
  } catch {
    /* quota / private mode */
  }
  if (process.env.NODE_ENV === 'production') return;
  const maxAge = 60 * 60 * 24 * 30;
  const secure = window.location.protocol === 'https:';
  document.cookie = `${AUTH_HINT_COOKIE}=1; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearClientSession(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  document.cookie = `${AUTH_HINT_COOKIE}=; Path=/; Max-Age=0`;
}

let bootstrapPromise: Promise<boolean> | null = null;

/**
 * Ensures localStorage has the JWT (from httpOnly cookie via Next `/session/bootstrap`).
 * Required in production when nginx sends `/api/*` to Nest, which only accepts Bearer auth.
 */
export async function ensureClientSession(options?: { force?: boolean }): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!options?.force && readStoredAccessToken()) return true;

  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      try {
        const res = await fetch('/session/bootstrap', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { accessToken?: string };
        if (!data.accessToken?.trim()) return false;
        persistClientSession(data.accessToken.trim());
        return true;
      } catch {
        return false;
      } finally {
        bootstrapPromise = null;
      }
    })();
  }
  return bootstrapPromise;
}
