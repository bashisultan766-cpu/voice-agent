import { NextRequest, NextResponse } from 'next/server';
import { getForwardedAccessToken } from '@/lib/proxy-auth-headers';
import { proxyToApi } from '@/lib/api/proxy';

export async function GET(request: NextRequest) {
  const token = await getForwardedAccessToken(request);
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }
  return proxyToApi({
    request,
    method: 'GET',
    upstreamPath: '/api/auth/me',
    includeCookie: true,
    unreachableMessage: 'API server is not running. Start apps/api.',
  });
}
