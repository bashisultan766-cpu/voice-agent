import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const token = request.cookies.get('va_access_token')?.value;
  /** Dashboard requires a real session cookie (SSR and API proxy depend on it). */
  const canAccessDashboard = Boolean(token?.trim());

  /**
   * After 401 we send users here with a stale httpOnly cookie still set.
   * Do not bounce them back to /dashboard — they must be allowed to sign in again.
   */
  const forceAuthPage =
    pathname === '/login' || pathname === '/register'
      ? searchParams.get('reason') === 'session-expired'
      : false;

  if (pathname.startsWith('/dashboard')) {
    if (!canAccessDashboard) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  if (pathname === '/dev-login' && process.env.NODE_ENV === 'production') {
    return new NextResponse(null, { status: 404 });
  }

  if (pathname === '/login' || pathname === '/register') {
    // Only skip login when we have a real cookie — not `va_auth_hint` alone (that would trap users in 401 loops).
    if (token && !forceAuthPage) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*', '/login', '/register', '/dev-login'],
};
