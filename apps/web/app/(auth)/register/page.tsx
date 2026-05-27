'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { persistClientSession } from '@/lib/auth/browser-session';

export default function RegisterPage() {
  const router = useRouter();
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceSlug, setWorkspaceSlug] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/session/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceName: workspaceName.trim(),
          workspaceSlug: workspaceSlug.trim() || undefined,
          fullName: fullName.trim(),
          email: email.trim(),
          password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data as { message?: string | string[] }).message;
        setError(typeof msg === 'string' ? msg : Array.isArray(msg) ? msg[0] : 'Registration failed');
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
      <h1 className="text-xl font-semibold">Create workspace</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        You will sign in with your workspace slug, email, and password. Already have an account?{' '}
        <Link href="/login" className="text-foreground underline underline-offset-2">
          Sign in
        </Link>
        .
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="workspaceName" className="block text-sm font-medium">
            Workspace name
          </label>
          <input
            id="workspaceName"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            required
            minLength={2}
            autoComplete="organization"
          />
        </div>
        <div>
          <label htmlFor="workspaceSlug" className="block text-sm font-medium">
            Workspace slug <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id="workspaceSlug"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
            value={workspaceSlug}
            onChange={(e) => setWorkspaceSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="e.g. my-brand (letters, numbers, hyphens)"
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Used at sign-in. If you leave this blank, we generate one from your workspace name.
          </p>
        </div>
        <div>
          <label htmlFor="fullName" className="block text-sm font-medium">
            Your name
          </label>
          <input
            id="fullName"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            minLength={1}
            autoComplete="name"
          />
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
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
            Password (min 8 characters)
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
    </div>
  );
}
