import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-2xl font-bold">AI Voice Agents Platform</h1>
      <p className="mt-2 text-muted-foreground">
        Manage Shopify Voice Agents
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/login"
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          Sign in
        </Link>
        <Link
          href="/register"
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Create workspace
        </Link>
      </div>
      {process.env.NODE_ENV === 'development' && (
        <p className="mt-10 max-w-md text-center text-xs text-muted-foreground">
          If you see 404 or JSON at this URL, confirm the admin is running on port 3000 and the API on 3001. From the
          repo root run{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">pnpm dev:local</code> (starts both).
        </p>
      )}
    </main>
  );
}
