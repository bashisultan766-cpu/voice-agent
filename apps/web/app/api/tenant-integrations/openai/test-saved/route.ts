import { NextRequest } from 'next/server';
import { proxyToApi } from '@/lib/api/proxy';

export async function POST(request: NextRequest) {
  return proxyToApi({
    request,
    method: 'POST',
    upstreamPath: '/api/tenant-integrations/openai/test-saved',
    includeCookie: true,
    unreachableMessage: 'API server is not running. Start apps/api.',
  });
}
