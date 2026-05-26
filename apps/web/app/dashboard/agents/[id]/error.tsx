'use client';

import Link from 'next/link';
import { parseApiErrorMessage } from '@/lib/api/error-message';

function friendlyAgentError(message: string): string {
  const trimmed = message.trim();
  if (trimmed.startsWith('{')) {
    return parseApiErrorMessage(trimmed, 401);
  }
  if (trimmed.toLowerCase().includes('authentication') || trimmed.includes('401')) {
    return 'Your session expired or you are not signed in. Please sign in again.';
  }
  return trimmed || 'We couldn’t load this agent. Please try again.';
}

export default function AgentDetailsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const friendly = friendlyAgentError(error.message || '');
  const needsLogin =
    friendly.toLowerCase().includes('sign in') || friendly.toLowerCase().includes('session');

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-16 text-center">
      <h3 className="text-lg font-medium text-foreground">Something went wrong</h3>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">{friendly}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-foreground/20"
        >
          Try again
        </button>
        <Link
          href="/dashboard/agents"
          className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
        >
          Back to Agents
        </Link>
        {needsLogin && (
          <Link
            href="/login?reason=session-expired"
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
          >
            Sign in again
          </Link>
        )}
      </div>
    </div>
  );
}
