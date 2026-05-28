import { NextRequest, NextResponse } from 'next/server';
import { getForwardedAccessToken } from '@/lib/proxy-auth-headers';

/**
 * Mirrors a valid JWT into the httpOnly cookie so Server Components can call the Nest API.
 * This lives outside `/api/*` so it is always handled by Next in production reverse proxies.
 */
export async function POST(request: NextRequest) {
  const token = await getForwardedAccessToken(request);
  if (!token?.trim()) {
    return NextResponse.json(
      { message: 'No access token provided. Sign in again.' },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set('va_access_token', token.trim(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === 'production',
  });
  return response;
}
