import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

/**
 * Restores browser localStorage JWT from the httpOnly session cookie.
 * Lives outside `/api/*` so production nginx (which proxies `/api/` to Nest) still hits Next.
 */
export async function GET() {
  const token = (await cookies()).get('va_access_token')?.value?.trim();
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }
  return NextResponse.json({ accessToken: token });
}
