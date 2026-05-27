'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  ensureClientSession,
  getBearerInit,
  readStoredAccessToken,
} from '@/lib/auth/browser-session';

/**
 * Keeps httpOnly va_access_token and localStorage in sync for SSR + direct Nest /api calls.
 */
export function SessionCookieSync() {
  const router = useRouter();
  const synced = useRef(false);

  useEffect(() => {
    if (synced.current) return;
    synced.current = true;

    const token = readStoredAccessToken();
    const work = token
      ? fetch('/session/session-sync', {
          method: 'POST',
          credentials: 'include',
          headers: getBearerInit(),
        })
      : ensureClientSession().then((ok) => (ok ? Promise.resolve(new Response(null, { status: 200 })) : null));

    void work
      .then((res) => {
        if (res?.ok) router.refresh();
      })
      .catch(() => {
        synced.current = false;
      });
  }, [router]);

  return null;
}
