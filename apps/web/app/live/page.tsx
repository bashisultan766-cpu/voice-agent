import Link from 'next/link';
import { cookies } from 'next/headers';
import { getAgentsServer } from '@/lib/api/agents-server';

export const dynamic = 'force-dynamic';

export default async function LiveHubPage() {
  const token = (await cookies()).get('va_access_token')?.value;

  if (!token) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-zinc-50 to-white px-6 py-16 text-zinc-900 dark:from-zinc-950 dark:to-zinc-900 dark:text-zinc-50">
        <div className="mx-auto max-w-lg text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Voice agent web pages</h1>
          <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Each agent has a public page at <code className="rounded bg-zinc-200 px-1 py-0.5 text-xs dark:bg-zinc-800">/live/(agent-id)</code>.
            Sign in to see your agents and open their pages, or use a link someone shared with you.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/login"
              className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900"
            >
              Sign in
            </Link>
            <Link href="/" className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium dark:border-zinc-600">
              Home
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const { items, error } = await getAgentsServer();

  if (error) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-16 dark:bg-zinc-950">
        <div className="mx-auto max-w-lg rounded-xl border border-red-200 bg-red-50/50 p-6 text-center dark:border-red-900 dark:bg-red-950/30">
          <h1 className="text-lg font-medium text-red-900 dark:text-red-200">Could not load agents</h1>
          <p className="mt-2 text-sm text-red-800 dark:text-red-300">{error}</p>
          <p className="mt-4 text-xs text-red-700/80 dark:text-red-400/90">
            Start the API on port 3001 and the admin on 3000: <code className="rounded bg-white/80 px-1 dark:bg-black/30">pnpm dev:local</code>
          </p>
          <Link href="/dashboard/agents" className="mt-6 inline-block text-sm font-medium text-red-900 underline dark:text-red-200">
            Back to Agents
          </Link>
        </div>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-zinc-50 to-white px-6 py-16 dark:from-zinc-950 dark:to-zinc-900">
        <div className="mx-auto max-w-lg text-center">
          <h1 className="text-2xl font-semibold">No agents yet</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Create an agent first, then its public page will appear here.</p>
          <Link
            href="/dashboard/agents/new"
            className="mt-8 inline-flex rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white dark:bg-white dark:text-zinc-900"
          >
            Create agent
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-50 to-white px-6 py-12 text-zinc-900 dark:from-zinc-950 dark:to-zinc-900 dark:text-zinc-50">
      <div className="mx-auto max-w-xl">
        <h1 className="text-2xl font-semibold tracking-tight">Your agents on the web</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Open the public page for each agent (shareable; no login required for visitors).
        </p>
        <ul className="mt-8 space-y-3">
          {items.map((a) => (
            <li key={a.id}>
              <Link
                href={`/live/${a.id}`}
                className="flex flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/80 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <span className="font-medium">{a.name}</span>
                  {a.storeName ? (
                    <span className="mt-0.5 block text-sm text-zinc-500 dark:text-zinc-400">{a.storeName}</span>
                  ) : null}
                  <span className="mt-1 inline-block rounded-md bg-zinc-100 px-2 py-0.5 text-xs capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {a.status}
                  </span>
                </div>
                <span className="mt-3 text-sm font-medium text-blue-600 dark:text-blue-400 sm:mt-0">View page →</span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-wrap gap-4 text-sm">
          <Link href="/dashboard/agents" className="text-zinc-600 underline dark:text-zinc-400">
            Dashboard · Agents
          </Link>
          <Link href="/dashboard" className="text-zinc-600 underline dark:text-zinc-400">
            Overview
          </Link>
        </div>
      </div>
    </main>
  );
}
