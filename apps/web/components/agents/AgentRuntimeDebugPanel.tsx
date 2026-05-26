'use client';

import { useEffect, useState } from 'react';
import type { CredentialSourcesSummaryApi } from '@/lib/api/agents';
import { authenticatedFetch } from '@/lib/api/authenticated-fetch';

type LiveMonitorPayload = {
  ok?: boolean;
  conversationStage?: string | null;
  orderState?: string | null;
  streamingStatus?: string;
  streamingMode?: string;
  agentSpeaking?: boolean;
  bargeInRequested?: boolean;
  interruptionCount?: number;
  partialTranscript?: string | null;
  deferredJobPhase?: string | null;
  latency?: {
    sttMs?: number | null;
    llmMs?: number | null;
    ttsMs?: number | null;
    toolMs?: number | null;
    llmTimeToFirstTokenMs?: number | null;
  };
  cost?: {
    totalEstimatedUsd?: number;
    openaiEstimatedUsd?: number;
    elevenlabsEstimatedUsd?: number;
  };
  recentTranscript?: Array<{ role: string; content: string }>;
  activeTools?: string[];
  updatedAt?: string;
};

interface RuntimeDebugPayload {
  liveMonitor?: Record<string, unknown> | null;
  toolsEnabled: string[];
  toolPermissions: Record<string, boolean>;
  personality: Record<string, number> | null;
  livePromptPreview: string;
  promptBudget?: {
    estimatedTokens: number;
    status: string;
    warnings: string[];
    recommendKnowledgeBase: boolean;
  };
  promptLayers?: {
    platform?: string;
    agentIdentity?: string;
    storePolicyKnowledge?: string;
    runtimeTools?: string;
    shopifyTruth?: string;
    knowledgeRetrieval?: string;
    runtimeContext?: string;
    /** @deprecated legacy shape */
    platformSafety?: string;
    platformCommerce?: string;
    agentCustom?: string;
  };
  activeRestrictions?: {
    blockedTopics: string | null;
    allowedTopics: string | null;
    forbiddenBehaviors: string | null;
  };
  lastToolCalls: Array<{
    toolName: string;
    status: string;
    latencyMs: number | null;
    inputPreview?: string;
    outputPreview?: string;
  }>;
  runtimeContextPreview: Record<string, unknown> | null;
  credentialSources?: CredentialSourcesSummaryApi;
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'agent':
      return 'agent-specific';
    case 'workspace':
      return 'workspace (opt-in)';
    case 'env':
      return 'environment (dev/single-tenant)';
    case 'missing':
      return 'missing';
    default:
      return source;
  }
}

function CredentialRow({
  label,
  source,
  ok,
  flagOn,
  flagLabel,
}: {
  label: string;
  source: string;
  ok: boolean;
  flagOn?: boolean;
  flagLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm border-b border-border/60 pb-2 last:border-0">
      <div>
        <span className="font-medium">{label}</span>
        {flagLabel ? (
          <span className="ml-2 text-xs text-muted-foreground">
            {flagOn ? `✓ ${flagLabel}` : `○ ${flagLabel} off`}
          </span>
        ) : null}
      </div>
      <span className={ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
        {sourceLabel(source)} {ok ? '✅' : '⚠️'}
      </span>
    </div>
  );
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
  const [promptTab, setPromptTab] = useState<'combined' | 'layers'>('layers');
  const [live, setLive] = useState<LiveMonitorPayload | null>(null);

  useEffect(() => {
    if (!callSessionId) {
      setLive(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await authenticatedFetch(
          `/api/calls/runtime/live-monitor?callSessionId=${encodeURIComponent(callSessionId)}`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as LiveMonitorPayload;
        if (!cancelled) setLive(json);
      } catch {
        /* ignore poll errors */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [callSessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = callSessionId ? `?callSessionId=${encodeURIComponent(callSessionId)}` : '';
        const res = await authenticatedFetch(`/api/agents/${agentId}/runtime-debug${qs}`);
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

  const cs = data.credentialSources;
  const layers = data.promptLayers;

  return (
    <div className="space-y-4">
      {callSessionId && live?.ok !== false ? (
        <div className="rounded-lg border border-primary/30 bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Live voice monitor</h3>
            <span className="text-xs text-muted-foreground">
              {live?.streamingStatus ?? 'idle'} · {live?.streamingMode ?? '—'}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Stage</dt>
              <dd className="font-medium">{live?.conversationStage ?? data.liveMonitor?.conversationStage ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Order state</dt>
              <dd className="font-medium">{live?.orderState ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Agent speaking</dt>
              <dd className="font-medium">{live?.agentSpeaking ? 'Yes' : 'No'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Barge-in / interrupts</dt>
              <dd className="font-medium">
                {live?.bargeInRequested ? 'Requested' : 'No'} ({live?.interruptionCount ?? 0})
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Deferred job</dt>
              <dd className="font-medium">{live?.deferredJobPhase ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Est. cost (USD)</dt>
              <dd className="font-medium">
                {live?.cost?.totalEstimatedUsd != null
                  ? live.cost.totalEstimatedUsd.toFixed(4)
                  : '—'}
              </dd>
            </div>
            {(live as { runtimeScores?: { salesEffectiveness?: number } })?.runtimeScores ? (
              <div className="col-span-2">
                <dt className="text-muted-foreground">Runtime scores</dt>
                <dd className="font-medium font-mono text-xs">
                  {JSON.stringify((live as { runtimeScores?: Record<string, number> }).runtimeScores)}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            Latency: STT {live?.latency?.sttMs ?? '—'}ms · LLM {live?.latency?.llmMs ?? '—'}ms · TTS{' '}
            {live?.latency?.ttsMs ?? '—'}ms · tools {live?.latency?.toolMs ?? '—'}ms
          </p>
          {live?.partialTranscript ? (
            <p className="mt-2 text-xs">
              <span className="font-medium">Partial STT:</span> {live.partialTranscript}
            </p>
          ) : null}
          {live?.recentTranscript && live.recentTranscript.length > 0 ? (
            <ul className="mt-2 max-h-32 overflow-y-auto space-y-1 text-xs font-mono">
              {live.recentTranscript.map((t, i) => (
                <li key={i}>
                  <span className="text-muted-foreground">{t.role}:</span> {t.content}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {cs ? (
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-semibold">Credential sources</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Runtime resolution for this agent. Secrets are never shown. Workspace keys apply only when the matching
            toggle is enabled on the agent.
          </p>
          <div className="mt-3 space-y-2">
            <CredentialRow
              label="Shopify"
              source={cs.shopify.source}
              ok={cs.shopify.configured && !(cs.shopify.source === 'workspace' && !cs.shopify.useWorkspaceShopify)}
              flagOn={cs.shopify.useWorkspaceShopify}
              flagLabel="use workspace Shopify"
            />
            <CredentialRow
              label="OpenAI"
              source={cs.openai.source}
              ok={cs.openai.configured}
              flagOn={cs.openai.useWorkspaceOpenai}
              flagLabel="use workspace OpenAI"
            />
            <CredentialRow
              label="ElevenLabs"
              source={cs.elevenlabs.source}
              ok={cs.elevenlabs.configured}
              flagOn={cs.elevenlabs.useWorkspaceElevenlabs}
              flagLabel="use workspace ElevenLabs"
            />
            <CredentialRow
              label="Twilio"
              source={cs.twilio.authSource}
              ok={cs.twilio.configured}
              flagOn={cs.twilio.useWorkspaceTwilio}
              flagLabel="use workspace Twilio"
            />
            <CredentialRow
              label="Email (Resend)"
              source={cs.resend.source}
              ok={cs.resend.configured}
              flagOn={cs.resend.useWorkspaceEmail}
              flagLabel="use workspace email"
            />
          </div>
        </div>
      ) : null}

      {data.activeRestrictions ? (
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-semibold">Active restrictions</h3>
          <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div>
              <dt className="font-medium text-foreground">Blocked topics</dt>
              <dd className="whitespace-pre-wrap">{data.activeRestrictions.blockedTopics || '—'}</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Allowed topics</dt>
              <dd className="whitespace-pre-wrap">{data.activeRestrictions.allowedTopics || '—'}</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Forbidden behaviors</dt>
              <dd className="whitespace-pre-wrap">{data.activeRestrictions.forbiddenBehaviors || '—'}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Runtime prompt</h3>
          <div className="flex gap-1 text-xs">
            <button
              type="button"
              className={`rounded px-2 py-1 ${promptTab === 'layers' ? 'bg-muted font-medium' : ''}`}
              onClick={() => setPromptTab('layers')}
            >
              Layers
            </button>
            <button
              type="button"
              className={`rounded px-2 py-1 ${promptTab === 'combined' ? 'bg-muted font-medium' : ''}`}
              onClick={() => setPromptTab('combined')}
            >
              Combined
            </button>
          </div>
        </div>
        {data.promptBudget ? (
          <div className="mt-2 rounded border border-border/60 bg-muted/30 p-2 text-xs">
            <p className="font-medium text-foreground">
              Prompt budget: ~{data.promptBudget.estimatedTokens} tokens ({data.promptBudget.status})
            </p>
            {data.promptBudget.recommendKnowledgeBase ? (
              <p className="mt-1 text-amber-700 dark:text-amber-400">
                Consider moving long FAQs and policies to the Knowledge Base.
              </p>
            ) : null}
            {data.promptBudget.warnings.map((w) => (
              <p key={w} className="mt-1 text-muted-foreground">
                {w}
              </p>
            ))}
          </div>
        ) : null}
        {promptTab === 'layers' && layers ? (
          <div className="mt-3 space-y-3 text-xs font-mono text-muted-foreground max-h-96 overflow-y-auto">
            <div>
              <p className="font-sans font-semibold text-foreground mb-1">1 — Platform (non-editable)</p>
              <pre className="whitespace-pre-wrap">{layers.platform ?? layers.platformSafety}</pre>
            </div>
            <div>
              <p className="font-sans font-semibold text-foreground mb-1">2 — Agent identity (editable)</p>
              <pre className="whitespace-pre-wrap">{layers.agentIdentity ?? layers.agentCustom}</pre>
            </div>
            <div>
              <p className="font-sans font-semibold text-foreground mb-1">3 — Store policy knowledge (retrieval)</p>
              <pre className="whitespace-pre-wrap">{layers.storePolicyKnowledge ?? '(see combined)'}</pre>
            </div>
            <div>
              <p className="font-sans font-semibold text-foreground mb-1">4 — Runtime tools & permissions</p>
              <pre className="whitespace-pre-wrap">{layers.runtimeTools ?? '(see combined)'}</pre>
            </div>
            <div>
              <p className="font-sans font-semibold text-foreground mb-1">5 — Shopify truth (tools only)</p>
              <pre className="whitespace-pre-wrap">{layers.shopifyTruth ?? layers.platformCommerce}</pre>
            </div>
            <div>
              <p className="font-sans font-semibold text-foreground mb-1">6 — Knowledge retrieval (per turn)</p>
              <pre className="whitespace-pre-wrap">{layers.knowledgeRetrieval ?? '(empty until live call)'}</pre>
            </div>
            <div>
              <p className="font-sans font-semibold text-foreground mb-1">7 — Runtime orchestration context</p>
              <pre className="whitespace-pre-wrap">{layers.runtimeContext || '(empty)'}</pre>
            </div>
          </div>
        ) : (
          <pre className="mt-2 max-h-96 overflow-y-auto text-xs font-mono text-muted-foreground whitespace-pre-wrap">
            {data.livePromptPreview}
          </pre>
        )}
      </div>

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
    </div>
  );
}
