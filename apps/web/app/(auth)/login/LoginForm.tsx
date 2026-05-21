'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearClientSession, persistClientSession } from '@/lib/auth/browser-session';

export type LoginFormProps = {
  /** Set from server `searchParams` on the login page (Next.js 15). */
  sessionExpired?: boolean;
};

export function LoginForm({ sessionExpired = false }: LoginFormProps) {
  const router = useRouter();
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionExpired) return;
    clearClientSession();
    void fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  }, [sessionExpired]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantSlug, email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data as { message?: string | string[] }).message;
        setError(typeof msg === 'string' ? msg : Array.isArray(msg) ? msg[0] : 'Sign in failed');
        return;
      }
      const token = (data as { accessToken?: string }).accessToken;
      if (token) persistClientSession(token);
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Use your workspace slug, email, and password. New here?{' '}
        <Link href="/register" className="text-foreground underline underline-offset-2">
          Create an account
        </Link>
        .
      </p>
      {sessionExpired ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your session expired. Please sign in again.
        </p>
      ) : null}
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="tenantSlug" className="block text-sm font-medium">
            Workspace slug
          </label>
          <input
            id="tenantSlug"
            name="tenantSlug"
            autoComplete="organization"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="e.g. my-store-brand"
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export function LoginFormFallback() {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
    </div>
  );
}
