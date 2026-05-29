'use client';



import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import Link from 'next/link';

import { useRouter } from 'next/navigation';

import type { AgentApi } from '@/lib/api/agents';

import { getAgent } from '@/lib/api/agents';

import { parseApiErrorMessage } from '@/lib/api/error-message';

import { ensureClientSession } from '@/lib/auth/browser-session';

import { normalizeAgentForClient } from '@/lib/agents/normalize-agent-for-client';



type AgentLoaderContextValue = {

  agent: AgentApi;

  reloadAgent: () => Promise<AgentApi | null>;

};



const AgentLoaderContext = createContext<AgentLoaderContextValue | null>(null);



export function useLoadedAgent(): AgentApi {

  const ctx = useContext(AgentLoaderContext);

  if (!ctx) {

    throw new Error('useLoadedAgent must be used within AgentPageLoader after the agent has loaded.');

  }

  return ctx.agent;

}



export function useAgentPageLoader(): AgentLoaderContextValue {

  const ctx = useContext(AgentLoaderContext);

  if (!ctx) {

    throw new Error('useAgentPageLoader must be used within AgentPageLoader after the agent has loaded.');

  }

  return ctx;

}



type AgentPageLoaderProps = {

  agentId: string;

  initialAgent?: AgentApi | null;

  children: ReactNode;

};



export function AgentPageLoader({ agentId, initialAgent, children }: AgentPageLoaderProps) {

  const router = useRouter();

  const normalizedInitialAgent = useMemo(

    () => normalizeAgentForClient(initialAgent),

    [initialAgent],

  );

  const [agent, setAgent] = useState<AgentApi | null>(normalizedInitialAgent);

  const [loading, setLoading] = useState(!normalizedInitialAgent);

  const [error, setError] = useState<string | null>(null);



  const fetchAgent = useCallback(async (): Promise<AgentApi | null> => {

    await ensureClientSession();

    const row = await getAgent(agentId);

    if (!row) {

      setError('Agent not found.');

      return null;

    }

    const normalized = normalizeAgentForClient(row);

    setAgent(normalized);

    setError(null);

    return normalized;

  }, [agentId]);



  const reloadAgent = useCallback(async () => fetchAgent(), [fetchAgent]);



  useEffect(() => {

    if (initialAgent) return;

    let cancelled = false;

    setLoading(true);

    setError(null);

    void fetchAgent()

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

  }, [agentId, initialAgent, router, fetchAgent]);



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



  return (

    <AgentLoaderContext.Provider value={{ agent, reloadAgent }}>

      {children}

    </AgentLoaderContext.Provider>

  );

}

