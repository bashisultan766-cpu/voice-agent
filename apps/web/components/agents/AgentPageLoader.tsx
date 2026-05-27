'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AgentApi } from '@/lib/api/agents';
import { getAgent } from '@/lib/api/agents';
import { parseApiErrorMessage } from '@/lib/api/error-message';
import { ensureClientSession } from '@/lib/auth/browser-session';

type AgentPageLoaderProps = {
  agentId: string;
  initialAgent?: AgentApi | null;
  children: (agent: AgentApi) => React.ReactNode;
};

export function AgentPageLoader({ agentId, initialAgent, children }: AgentPageLoaderProps) {
  const router = useRouter();
  const [agent, setAgent] = useState<AgentApi | null>(initialAgent ?? null);
  const [loading, setLoading] = useState(!initialAgent);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialAgent) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void ensureClientSession()
      .then(() => getAgent(agentId))
      .then((row) => {
        if (cancelled) return;
        if (!row) {
          setError('Agent not found.');
          return;
        }
        setAgent(row);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to load agent.';
        setError(msg);
        if (msg.toLowerCase().includes('session expired') || msg.includes('not authenticated')) {
          router.replace('/login?reason=session-expired');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, initialAgent, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-muted/20 px-6 py-16 text-sm text-muted-foreground">
        Loading agent…
      </div>
    );
  }

  if (error || !agent) {
    const friendly = error ? parseApiErrorMessage(error, 401) : 'Agent not found.';
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-16 text-center">
        <h3 className="text-lg font-medium text-foreground">Something went wrong</h3>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{friendly}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href={`/dashboard/agents/${agentId}`}
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            View agent
          </Link>
          <Link
            href="/dashboard/agents"
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            Back to Agents
          </Link>
          <Link
            href="/login?reason=session-expired"
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            Sign in again
          </Link>
        </div>
      </div>
    );
  }

  return <>{children(agent)}</>;
}
