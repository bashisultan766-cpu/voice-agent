'use client';

import { useEffect, useState } from 'react';

interface RuntimeDebugPayload {
  toolsEnabled: string[];
  toolPermissions: Record<string, boolean>;
  personality: Record<string, number> | null;
  livePromptPreview: string;
  lastToolCalls: Array<{
    toolName: string;
    status: string;
    latencyMs: number | null;
    inputPreview?: string;
    outputPreview?: string;
  }>;
  runtimeContextPreview: Record<string, unknown> | null;
}

export function AgentRuntimeDebugPanel({
  agentId,
  callSessionId,
}: {
  agentId: string;
  callSessionId?: string;
}) {
  const [data, setData] = useState<RuntimeDebugPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = callSessionId ? `?callSessionId=${encodeURIComponent(callSessionId)}` : '';
        const res = await fetch(`/api/agents/${agentId}/runtime-debug${qs}`, { credentials: 'include' });
        if (!res.ok) throw new Error(await res.text());
        const json = (await res.json()) as RuntimeDebugPayload;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load debug data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, callSessionId]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading runtime debug…</p>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold">Tools enabled ({data.toolsEnabled.length})</h3>
        <p className="mt-2 font-mono text-xs text-muted-foreground">{data.toolsEnabled.join(', ')}</p>
      </div>
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold">Last tool calls</h3>
        {data.lastToolCalls.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No tool executions yet.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-xs">
            {data.lastToolCalls.map((t, i) => (
              <li key={i} className="rounded border p-2 font-mono">
                <span className="font-semibold">{t.toolName}</span> — {t.status}
                {t.latencyMs != null ? ` (${t.latencyMs}ms)` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold">Live prompt preview</h3>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {data.livePromptPreview}
        </pre>
      </div>
      {data.runtimeContextPreview ? (
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-semibold">Runtime context preview</h3>
          <pre className="mt-2 max-h-48 overflow-auto text-xs text-muted-foreground">
            {JSON.stringify(data.runtimeContextPreview, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
