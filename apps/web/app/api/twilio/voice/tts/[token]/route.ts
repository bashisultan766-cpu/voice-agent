import { NextRequest, NextResponse } from 'next/server';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const upstream = await fetch(
    `${getServerApiBaseUrl()}/api/twilio/voice/tts/${encodeURIComponent(token)}`,
    {
      method: 'GET',
      cache: 'no-store',
    },
  );

  const audio = await upstream.arrayBuffer();
  return new NextResponse(audio, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
}
