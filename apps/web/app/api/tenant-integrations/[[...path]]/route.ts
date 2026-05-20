import { NextRequest } from 'next/server';
import { proxyToApi } from '@/lib/api/proxy';

async function proxy(request: NextRequest, pathSegments: string[], method: string) {
  const suffix = pathSegments.length ? `/${pathSegments.join('/')}` : '';
  return proxyToApi({
    request,
    method,
    upstreamPath: `/api/tenant-integrations${suffix}`,
    includeCookie: true,
    unreachableMessage: 'API server is not running. Start apps/api.',
  });
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  return proxy(request, path ?? [], 'GET');
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  return proxy(request, path ?? [], 'POST');
}

export async function PUT(request: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  return proxy(request, path ?? [], 'PUT');
}
