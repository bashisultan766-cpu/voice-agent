import { NextResponse } from 'next/server';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

export async function GET() {
  try {
    const res = await fetch(`${getServerApiBaseUrl()}/api/health`, { cache: 'no-store' });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `API server is not running. Start apps/api.${err instanceof Error ? ` (${err.message})` : ''}` },
      { status: 502 },
    );
  }
}

