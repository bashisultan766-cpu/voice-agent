import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

/**
 * JWT forwarded from Next route handlers to Nest. Prefer the incoming `Authorization: Bearer`
 * header so a freshly stored client token overrides a stale httpOnly cookie (common in local dev).
 */
export async function getForwardedAccessToken(request?: NextRequest): Promise<string | null> {
  const header = request?.headers.get('authorization');
  const fromHeader = header?.match(/^Bearer\s+(\S+)/i)?.[1]?.trim();
  if (fromHeader) return fromHeader;
  return (await cookies()).get('va_access_token')?.value ?? null;
}

export async function proxyAuthHeaders(request?: NextRequest): Promise<Record<string, string>> {
  const token = await getForwardedAccessToken(request);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
