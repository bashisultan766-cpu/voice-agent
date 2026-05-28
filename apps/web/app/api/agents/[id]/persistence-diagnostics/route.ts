import { NextRequest } from 'next/server';
import { proxyToApi } from '@/lib/api/proxy';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return proxyToApi({
    request,
    method: 'GET',
    upstreamPath: `/api/agents/${encodeURIComponent(id)}/persistence-diagnostics`,
    includeCookie: true,
    unreachableMessage: 'API server is not running. Start apps/api.',
  });
}
