import { NextRequest, NextResponse } from 'next/server';
import { getServerApiBaseUrl } from '@/lib/server-api-base';
import { proxyAuthHeaders } from '@/lib/proxy-auth-headers';

type ProxyOptions = {
  upstreamPath: string;
  method: string;
  request: NextRequest;
  includeCookie?: boolean;
  noAuth?: boolean;
  passthroughRedirects?: boolean;
  unreachableMessage?: string;
};

function toErrorJsonBody(text: string, status: number): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return { message: `Upstream request failed (${status}).` };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // fall through: upstream body is plain text/html
  }
  return {
    message:
      status === 401
        ? trimmed || 'Not authenticated.'
        : trimmed.length < 600
          ? trimmed
          : `Upstream request failed (${status}).`,
  };
}

function candidateApiBases(): string[] {
  const primary = getServerApiBaseUrl().replace(/\/$/, '');
  const out = [primary];
  try {
    const u = new URL(primary);
    if (u.hostname === '127.0.0.1') {
      u.hostname = 'localhost';
      out.push(u.href.replace(/\/$/, ''));
    } else if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1';
      out.push(u.href.replace(/\/$/, ''));
    }
  } catch {
    // use primary only
  }
  return [...new Set(out)];
}

export async function proxyToApi(options: ProxyOptions): Promise<NextResponse> {
  const {
    upstreamPath,
    method,
    request,
    includeCookie = true,
    noAuth = false,
    passthroughRedirects = false,
    unreachableMessage = 'API server is not running. Start apps/api.',
  } = options;
  try {
    const headers: Record<string, string> = noAuth ? {} : { ...(await proxyAuthHeaders(request)) };
    if (includeCookie) {
      const cookie = request.headers.get('cookie');
      if (cookie) headers.Cookie = cookie;
    }
    const ct = request.headers.get('content-type');
    if (ct) headers['Content-Type'] = ct;
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text().catch(() => undefined);
    let response: Response | null = null;
    let lastError: unknown = null;
    const bases = candidateApiBases();
    for (const base of bases) {
      const upstreamUrl = `${base}${upstreamPath}${request.nextUrl.search}`;
      try {
        response = await fetch(upstreamUrl, {
          method,
          headers,
          body,
          cache: 'no-store',
          ...(passthroughRedirects ? { redirect: 'manual' as const } : {}),
        });
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!response) throw lastError ?? new Error('Unable to reach API upstream.');

    if (passthroughRedirects) {
      const location = response.headers.get('location');
      if (location && response.status >= 300 && response.status < 400) {
        return NextResponse.redirect(location, { status: response.status });
      }
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok) {
      return NextResponse.json(toErrorJsonBody(text, response.status), { status: response.status });
    }

    if (contentType.includes('application/json')) {
      try {
        return NextResponse.json(text ? (JSON.parse(text) as unknown) : {}, { status: response.status });
      } catch {
        return NextResponse.json({ message: 'Invalid JSON from upstream API.' }, { status: 502 });
      }
    }

    const out = new NextResponse(text, { status: response.status });
    if (contentType) out.headers.set('content-type', contentType);
    return out;
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
    return NextResponse.json({ message: `${unreachableMessage}${detail}` }, { status: 502 });
  }
}
