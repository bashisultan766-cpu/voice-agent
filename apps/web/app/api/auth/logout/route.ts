import { NextResponse } from 'next/server';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set('va_access_token', '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
