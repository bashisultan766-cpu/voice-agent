'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getBearerInit, readStoredAccessToken } from '@/lib/auth/browser-session';

/**
 * Keeps httpOnly va_access_token aligned with localStorage for SSR (getAgentServer, etc.).
 */
export function SessionCookieSync() {
  const router = useRouter();
  const synced = useRef(false);

  useEffect(() => {
    const token = readStoredAccessToken();
    if (!token || synced.current) return;
    synced.current = true;

    void fetch('/api/auth/session-sync', {
      method: 'POST',
      credentials: 'include',
      headers: getBearerInit(),
    })
      .then((res) => {
        if (res.ok) router.refresh();
      })
      .catch(() => {
        synced.current = false;
      });
  }, [router]);

  return null;
}
