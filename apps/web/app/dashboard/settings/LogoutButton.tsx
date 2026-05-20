'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { clearClientSession } from '@/lib/auth/browser-session';

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  return (
    <button
      type="button"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        try {
          clearClientSession();
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
          router.push('/login');
          router.refresh();
        } finally {
          setLoading(false);
        }
      }}
      className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
    >
      {loading ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
