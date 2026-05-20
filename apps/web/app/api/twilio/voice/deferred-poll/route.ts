import { NextRequest, NextResponse } from 'next/server';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const proxySecret = process.env.TWILIO_PROXY_SHARED_SECRET?.trim();
  const upstreamUrl = new URL(`${getServerApiBaseUrl()}/api/twilio/voice/deferred-poll`);
  const host = request.headers.get('host');
  const externalProto = request.nextUrl.protocol.replace(':', '') || 'https';
  const externalUrl = `${request.nextUrl.origin}${request.nextUrl.pathname}${request.nextUrl.search}`;
  const callSessionId = request.nextUrl.searchParams.get('callSessionId');
  if (callSessionId) {
    upstreamUrl.searchParams.set('callSessionId', callSessionId);
  }

  const upstream = await fetch(upstreamUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(request.headers.get('x-twilio-signature')
        ? { 'x-twilio-signature': request.headers.get('x-twilio-signature') as string }
        : {}),
      ...(host ? { 'x-forwarded-host': host } : {}),
      'x-forwarded-proto': externalProto,
      'x-original-url': externalUrl,
      ...(proxySecret ? { 'x-twilio-proxy-secret': proxySecret } : {}),
    },
    body: rawBody,
    cache: 'no-store',
  });

  const xml = await upstream.text();
  return new NextResponse(xml, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
    },
  });
}
