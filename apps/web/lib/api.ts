import { getBearerInit } from '@/lib/auth/browser-session';

/**
 * Browser: same-origin paths use the admin session (cookie + optional Bearer from storage).
 * Server / Node: uses `NEXT_PUBLIC_API_URL` as origin when set.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const isBrowser = typeof window !== 'undefined';
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = isBrowser
    ? normalized
    : `${(process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')}${normalized}`;
  const res = await fetch(url, {
    ...init,
    credentials: isBrowser ? 'include' : init?.credentials,
    headers: {
      'Content-Type': 'application/json',
      ...(isBrowser ? getBearerInit() : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}
