import Link from 'next/link';

export default function LiveAgentNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agent not found</h1>
      <p className="mt-2 max-w-sm text-center text-sm text-zinc-600 dark:text-zinc-400">
        This link may be wrong or the agent was removed.
      </p>
      <Link href="/" className="mt-8 text-sm font-medium text-zinc-900 underline dark:text-zinc-100">
        Home
      </Link>
    </main>
  );
}
