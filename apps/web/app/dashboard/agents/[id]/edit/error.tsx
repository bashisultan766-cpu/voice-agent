'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function AgentEditError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : '';

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-16 text-center">
      <h3 className="text-lg font-medium text-foreground">Something went wrong</h3>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {error.message || 'We couldn’t load this agent for editing. Please try again.'}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-foreground/20"
        >
          Try again
        </button>
        {id && (
          <Link
            href={`/dashboard/agents/${id}`}
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
          >
            View agent
          </Link>
        )}
        <Link
          href="/dashboard/agents"
          className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
        >
          Back to Agents
        </Link>
      </div>
    </div>
  );
}
