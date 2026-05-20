import { cookies } from 'next/headers';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

export type SessionProfile = {
  tenant: { id: string; name: string; slug: string };
  user: { id: string; email: string; fullName: string | null; role: string };
};

async function authHeaders(): Promise<Record<string, string>> {
  const token = (await cookies()).get('va_access_token')?.value;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function getSessionProfile(): Promise<{ profile: SessionProfile | null; error: string | null }> {
  try {
    const res = await fetch(`${getServerApiBaseUrl()}/api/auth/me`, {
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      cache: 'no-store',
    });
    const text = await res.text();
    if (res.status === 401) {
      return { profile: null, error: null };
    }
    if (!res.ok) {
      return { profile: null, error: text?.slice(0, 200) || `Could not load session (${res.status}).` };
    }
    const data = text ? (JSON.parse(text) as SessionProfile) : null;
    if (!data?.user?.email || !data?.tenant?.name) {
      return { profile: null, error: 'Invalid session response.' };
    }
    return { profile: data, error: null };
  } catch (e) {
    return {
      profile: null,
      error:
        e instanceof Error
          ? e.message
          : 'Could not reach the API. Check that the backend is running and INTERNAL_API_URL / NEXT_PUBLIC_API_URL is set.',
    };
  }
}
