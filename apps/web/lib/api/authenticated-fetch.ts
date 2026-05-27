/**
 * Browser-authenticated fetch for same-origin `/api/*` routes.
 * Attaches JWT from localStorage as Authorization Bearer (required when nginx proxies /api to Nest).
 */
import { clearClientSession, ensureClientSession, getBearerInit } from '@/lib/auth/browser-session';
import { parseApiErrorMessage } from '@/lib/api/error-message';

export type AuthenticatedFetchInit = RequestInit & {
  /** When true, do not redirect to login on 401 (e.g. auth/me probe). */
  skipAuthRedirect?: boolean;
  /** When false, omit default Content-Type: application/json. */
  json?: boolean;
};

export function getAuthenticatedHeaders(extra?: HeadersInit, json = true): HeadersInit {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...getBearerInit(),
    ...(extra ?? {}),
  };
}

function handleUnauthorized(res: Response, skipRedirect?: boolean): void {
  if (res.status !== 401 || skipRedirect) return;
  if (typeof window !== 'undefined') {
    clearClientSession();
    window.location.href = '/login?reason=session-expired';
    throw new Error('Session expired. Please sign in again.');
  }
  throw new Error('Not authenticated. Sign in to continue.');
}

/** Fetch with Bearer token + cookies; redirects to login on 401 unless skipAuthRedirect. */
export async function authenticatedFetch(
  input: string,
  init?: AuthenticatedFetchInit,
): Promise<Response> {
  const { skipAuthRedirect, json = true, headers, ...rest } = init ?? {};
  await ensureClientSession();

  const doFetch = () =>
    fetch(input, {
      ...rest,
      credentials: rest.credentials ?? 'include',
      headers: getAuthenticatedHeaders(headers, json),
    });

  let res = await doFetch();

  // Stale localStorage Bearer overrides a valid cookie when nginx proxies /api to Nest.
  if (res.status === 401 && !skipAuthRedirect) {
    clearClientSession();
    if (await ensureClientSession({ force: true })) {
      res = await doFetch();
    }
  }

  handleUnauthorized(res, skipAuthRedirect);
  return res;
}

export async function authenticatedFetchJson<T>(
  input: string,
  init?: AuthenticatedFetchInit,
): Promise<T> {
  const res = await authenticatedFetch(input, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiErrorMessage(text, res.status));
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    return {} as T;
  }
  return res.json() as Promise<T>;
}
