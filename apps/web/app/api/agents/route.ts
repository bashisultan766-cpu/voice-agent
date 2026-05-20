import { NextRequest } from 'next/server';
import { proxyToApi } from '@/lib/api/proxy';

/**
 * GET /api/agents — Proxy to backend with session cookie.
 * Never return a fake empty list on error (that hid401 / API-down from the UI).
 */
export async function GET(request: NextRequest) {
  return proxyToApi({
    request,
    method: 'GET',
    upstreamPath: '/api/agents',
    includeCookie: true,
    unreachableMessage: 'API server is not running. Start apps/api.',
  });
}

/**
 * POST /api/agents — Proxy create agent to backend.
 */
export async function POST(request: NextRequest) {
  return proxyToApi({
    request,
    method: 'POST',
    upstreamPath: '/api/agents',
    includeCookie: true,
    unreachableMessage: 'API server is not running. Start apps/api.',
  });
}
