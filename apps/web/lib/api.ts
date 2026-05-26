import { authenticatedFetchJson } from '@/lib/api/authenticated-fetch';

/**
 * Browser: same-origin paths use the admin session (cookie + Bearer from localStorage).
 * Server / Node: uses `NEXT_PUBLIC_API_URL` as origin when set.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const isBrowser = typeof window !== 'undefined';
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = isBrowser
    ? normalized
    : `${(process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')}${normalized}`;
  if (isBrowser) {
    return authenticatedFetchJson<T>(url, init);
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}
