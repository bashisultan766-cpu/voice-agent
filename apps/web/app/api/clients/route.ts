import { NextRequest } from 'next/server';
import { proxyToApi } from '@/lib/api/proxy';

export async function GET(request: NextRequest) {
  return proxyToApi({
    request,
    method: 'GET',
    upstreamPath: '/api/clients',
    includeCookie: true,
    unreachableMessage: 'API server is not running. Start apps/api.',
  });
}
