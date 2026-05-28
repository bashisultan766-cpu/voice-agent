import { NextRequest, NextResponse } from 'next/server';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const res = await fetch(`${getServerApiBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }
    const token = (data as { accessToken?: string }).accessToken;
    const response = NextResponse.json(data, { status: 200 });
    if (token) {
      response.cookies.set('va_access_token', token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
        secure: process.env.NODE_ENV === 'production',
      });
    }
    return response;
  } catch (err) {
    return NextResponse.json(
      { message: `API server is not running. Start apps/api.${err instanceof Error ? ` (${err.message})` : ''}` },
      { status: 502 },
    );
  }
}
