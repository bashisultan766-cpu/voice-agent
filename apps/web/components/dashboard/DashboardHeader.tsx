'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearClientSession, ensureClientSession, getBearerInit } from '@/lib/auth/browser-session';

type Me = {
  user?: { email?: string; fullName?: string | null };
  tenant?: { name?: string; slug?: string };
};

export function DashboardHeader() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    void ensureClientSession().then(() =>
      fetch('/api/auth/me', {
        cache: 'no-store',
        credentials: 'include',
        headers: { ...getBearerInit() },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => setMe(data))
        .catch(() => setMe(null)),
    );
  }, []);

  async function logout() {
    clearClientSession();
    await fetch('/session/logout', { method: 'POST', credentials: 'include' });
    router.push('/login');
    router.refresh();
  }

  const label = me?.user?.fullName || me?.user?.email || me?.tenant?.name || 'Account';

  return (
    <header className="flex h-14 items-center justify-between border-b border-border/70 bg-card/75 px-6 backdrop-blur">
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm text-muted-foreground">
          {me?.tenant?.slug ? (
            <>
              Workspace <span className="font-medium text-foreground">{me.tenant.slug}</span>
              <span className="mx-1">·</span>
            </>
          ) : null}
          <span className="text-foreground">{label}</span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => void logout()}
        className="shrink-0 rounded-md border border-border bg-background/70 px-3 py-1.5 text-sm hover:bg-muted"
      >
        Sign out
      </button>
    </header>
  );
}
