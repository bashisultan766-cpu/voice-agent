import { NextRequest, NextResponse } from 'next/server';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

/**
 * GET /api/public/agents/[id] — proxy to Nest public card (no auth).
 * Lets the /live page use same-origin fetch during SSR (avoids some local networking issues).
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const safeId = encodeURIComponent(id);
  try {
    const res = await fetch(`${getServerApiBaseUrl()}/api/public/agents/${safeId}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const text = await res.text();
    const ct = res.headers.get('content-type') ?? 'application/json';
    return new NextResponse(text, { status: res.status, headers: { 'content-type': ct } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy error';
    return NextResponse.json(
      { message: `${message}. Is the API running on port 3001?` },
      { status: 502 },
    );
  }
}
