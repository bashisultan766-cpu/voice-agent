'use client';

import { useState, useEffect, useMemo, useCallback, Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { getAgents, deleteAgent, type AgentListItem } from '@/lib/api/agents';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { Pagination } from '@/components/dashboard/ops/TableStates';
import { AgentsDashboardSkeleton } from './AgentsDashboardSkeleton';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { AgentActionsDropdown } from './AgentActionsDropdown';
import { AgentStatusDropdown } from './AgentStatusDropdown';
import { EmptyState } from './EmptyState';

const PAGE_SIZE = 12;
const AGENTS_CACHE_KEY = 'voice_ops_agents_cache_v1';

const STATUS_OPTIONS: { value: 'all' | 'draft' | 'active' | 'paused'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'paused', label: 'Paused' },
];

/** UTC YYYY-MM-DD — must match server and client or hydration breaks (and clicks stop working). */
function formatUpdatedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

const connectionStyles: Record<AgentListItem['shopifyConnectionStatus'], string> = {
  ok: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  failed: 'bg-red-50 text-red-600 border border-red-100',
  unknown: 'bg-slate-50 text-slate-500 border border-slate-200',
};

function ConnectionBadge({
  status,
  compact,
}: {
  status: AgentListItem['shopifyConnectionStatus'];
  compact?: boolean;
}) {
  const label = status === 'ok' ? (compact ? 'OK' : 'Connected') : status === 'failed' ? (compact ? 'Fail' : 'Failed') : '—';
  return (
    <span
      className={`inline-flex shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium sm:text-xs sm:px-2 ${connectionStyles[status]}`}
      title={status === 'ok' ? 'Connected' : status === 'failed' ? 'Failed' : 'Unknown'}
    >
      {label}
    </span>
  );
}

function IntegrationPills({ agent }: { agent: AgentListItem }) {
  const items: Array<{ key: string; label: string; node: ReactNode }> = [
    { key: 'shopify', label: 'Shopify', node: <ConnectionBadge status={agent.shopifyConnectionStatus} compact /> },
    {
      key: 'catalog',
      label: 'Catalog',
      node: (
        <span
          className={`inline-flex shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium sm:text-xs sm:px-2 ${
            agent.catalogReady
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
              : 'bg-amber-50 text-amber-700 border border-amber-100'
          }`}
        >
          {agent.catalogReady ? 'Cat OK' : 'Cat —'}
        </span>
      ),
    },
    { key: 'database', label: 'Database', node: <ConnectionBadge status={agent.databaseConnectionStatus} compact /> },
    { key: 'twilio', label: 'Twilio', node: <ConnectionBadge status={agent.twilioConnectionStatus} compact /> },
    { key: 'openai', label: 'OpenAI', node: <ConnectionBadge status={agent.openaiConnectionStatus} compact /> },
    { key: 'elevenlabs', label: 'ElevenLabs', node: <ConnectionBadge status={agent.elevenlabsConnectionStatus} compact /> },
  ];
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {items.map((item) => (
        <span key={item.key} title={item.label}>
          {item.node}
        </span>
      ))}
    </div>
  );
}

type AgentsDashboardProps = {
  /** When true, the server already loaded the list — skip the client mount fetch. */
  skipInitialFetch?: boolean;
  initialAgents?: AgentListItem[];
  initialError?: string | null;
};

export function AgentsDashboard({
  skipInitialFetch = false,
  initialAgents = [],
  initialError = null,
}: AgentsDashboardProps = {}) {
  const readCachedAgents = (): AgentListItem[] => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(AGENTS_CACHE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as AgentListItem[];
    } catch {
      return [];
    }
  };
  const hasInitialAgents = initialAgents.length > 0;
  const initialCachedAgents = hasInitialAgents ? [] : readCachedAgents();
  const [agents, setAgents] = useState<AgentListItem[]>(
    hasInitialAgents ? initialAgents : initialCachedAgents,
  );
  const [showCachedDataBadge, setShowCachedDataBadge] = useState(
    !hasInitialAgents && initialCachedAgents.length > 0,
  );
  const [loading, setLoading] = useState(!skipInitialFetch);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(initialError);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'active' | 'paused'>('all');
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<AgentListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  const patchAgentStatus = useCallback((agentId: string, status: AgentListItem['status']) => {
    setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, status } : a)));
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(AGENTS_CACHE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as AgentListItem[];
        if (!Array.isArray(parsed)) return;
        window.localStorage.setItem(
          AGENTS_CACHE_KEY,
          JSON.stringify(parsed.map((a) => (a.id === agentId ? { ...a, status } : a))),
        );
      } catch {
        /* ignore cache write errors */
      }
    }
  }, []);

  const fetchAgents = useCallback(async (mode: 'full' | 'soft' = 'full') => {
    const soft = mode === 'soft' && agents.length > 0;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setFetchError(null);
    try {
      const list = await getAgents();
      setAgents(list);
      setShowCachedDataBadge(false);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(AGENTS_CACHE_KEY, JSON.stringify(list));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load agents.';
      setFetchError(msg);
      if (agents.length > 0) setShowCachedDataBadge(true);
      // Keep last known list so transient API outages do not look like data loss.
    } finally {
      if (soft) setRefreshing(false);
      else setLoading(false);
    }
  }, [agents.length]);

  useEffect(() => {
    if (!skipInitialFetch) {
      void fetchAgents('full');
      return;
    }
    // Server can return an empty list if the API was briefly down; re-fetch once from the client.
    if (initialError != null || initialAgents.length > 0) return;
    const t = window.setTimeout(() => void fetchAgents('full'), 0);
    return () => window.clearTimeout(t);
  }, [skipInitialFetch, initialError, initialAgents.length, fetchAgents]);

  const filtered = useMemo(() => {
    let list = agents;
    if (statusFilter !== 'all') {
      list = list.filter((a) => a.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.storeName?.toLowerCase().includes(q) ?? false) ||
          (a.voice?.toLowerCase().includes(q) ?? false),
      );
    }
    return list;
  }, [agents, statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteAgent(deleteTarget.id);
      setDeleteTarget(null);
      await fetchAgents(agents.length > 0 ? 'soft' : 'full');
    } finally {
      setDeleting(false);
    }
  };

  if (loading && agents.length === 0 && !fetchError) {
    return (
      <div className="w-full max-w-full min-w-0 space-y-8 overflow-x-hidden">
        <PageHeader
          title="Agents"
          description="Create and manage Shopify-connected voice agents for your stores."
        />
        <AgentsDashboardSkeleton />
      </div>
    );
  }

  if (fetchError && agents.length === 0) {
    return (
      <div className="w-full max-w-full min-w-0 space-y-8 overflow-x-hidden">
        <PageHeader
          title="Agents"
          description="Create and manage Shopify-connected voice agents for your stores."
        />
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-8 py-20 text-center">
          <p className="text-sm font-medium text-foreground">Couldn’t load agents</p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">{fetchError}</p>
          <p className="mt-3 max-w-sm text-xs text-muted-foreground">
            Ensure the API is running (e.g. npm run dev in apps/api) and the database is set up (pnpm db:migrate).
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => void fetchAgents('full')}
              className="rounded-lg border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-foreground/20"
            >
              Try again
            </button>
            <Link
              href="/dashboard/agents/new"
              className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-foreground/10"
            >
              Create Agent anyway
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-full min-w-0 space-y-8 overflow-x-hidden">
      <PageHeader
        title="Agents"
        description="Create and manage Shopify-connected voice agents for your stores."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/dashboard/agents/health"
              className="inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground shadow-sm hover:bg-muted focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:ring-offset-2"
            >
              Health
            </Link>
            <Link
              href="/dashboard/agents/new"
              className="inline-flex shrink-0 items-center justify-center rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2"
            >
              Create agent
            </Link>
          </div>
        }
      />

      {agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Create your first voice agent to handle calls, answer questions, and connect to your knowledge base."
          actionLabel="Create Agent"
          actionHref="/dashboard/agents/new"
        />
      ) : (
        <>
          {showCachedDataBadge ? (
            <p className="rounded-lg border border-blue-200 bg-blue-50/90 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
              Showing cached agents from your last successful load. Live API data will replace this automatically once the connection is healthy.
            </p>
          ) : null}
          {fetchError && agents.length > 0 ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              {fetchError}{' '}
              <button type="button" onClick={() => void fetchAgents('soft')} className="font-medium underline">
                Retry
              </button>
            </p>
          ) : null}
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search agents…" className="sm:max-w-sm" />
            <RefreshButton
              onClick={() => void fetchAgents(agents.length > 0 ? 'soft' : 'full')}
              loading={loading || refreshing}
            />
            <div className="flex flex-wrap gap-1.5">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setStatusFilter(opt.value)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    statusFilter === opt.value
                      ? 'bg-foreground text-background'
                      : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className={`overflow-hidden rounded-xl border border-border bg-card ${refreshing ? 'opacity-70 transition-opacity' : ''}`}
          >
            {filtered.length === 0 ? (
              <p className="px-5 py-14 text-center text-sm text-muted-foreground">
                No agents match your search or filter.
              </p>
            ) : (
              <>
                <div className="space-y-3 p-4 lg:hidden">
                  {paged.map((agent) => (
                    <article
                      key={agent.id}
                      className="min-w-0 rounded-lg border border-border bg-background p-4 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/dashboard/agents/${agent.id}`}
                            className="block truncate font-medium text-foreground hover:text-muted-foreground"
                          >
                            {agent.name}
                          </Link>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {agent.storeName ?? 'No store'} · {formatUpdatedAt(agent.updatedAt)}
                          </p>
                          {agent.voice ? (
                            <p className="mt-1 break-words text-xs text-muted-foreground">{agent.voice}</p>
                          ) : null}
                        </div>
                        <AgentActionsDropdown
                          agent={agent}
                          onDeleteRequest={setDeleteTarget}
                          onActionEnd={() => void fetchAgents(agents.length > 0 ? 'soft' : 'full')}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <AgentStatusDropdown
                          agent={agent}
                          onStatusChanged={(status) => patchAgentStatus(agent.id, status)}
                        />
                      </div>
                      <div className="mt-3">
                        <IntegrationPills agent={agent} />
                      </div>
                    </article>
                  ))}
                </div>

                <div className="hidden lg:block">
                  <table className="w-full table-fixed text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/30">
                        <th className="w-[22%] px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Agent
                        </th>
                        <th className="w-[14%] px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Store
                        </th>
                        <th className="w-[12%] px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Status
                        </th>
                        <th className="w-[30%] px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Integrations
                        </th>
                        <th className="w-[10%] px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Updated
                        </th>
                        <th className="w-10 px-2 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {paged.map((agent) => {
                        const expanded = expandedAgentId === agent.id;
                        return (
                          <Fragment key={agent.id}>
                            <tr className="border-b border-border hover:bg-muted/30 transition-colors">
                              <td className="min-w-0 px-4 py-3">
                                <Link
                                  href={`/dashboard/agents/${agent.id}`}
                                  className="block truncate font-medium text-foreground hover:text-muted-foreground"
                                  title={agent.name}
                                >
                                  {agent.name}
                                </Link>
                                {agent.voice ? (
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground" title={agent.voice}>
                                    {agent.voice}
                                  </p>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => setExpandedAgentId(expanded ? null : agent.id)}
                                  className="mt-1 text-xs text-violet-600 hover:underline"
                                >
                                  {expanded ? 'Hide details' : 'Show details'}
                                </button>
                              </td>
                              <td className="min-w-0 px-3 py-3">
                                <span className="block truncate text-muted-foreground" title={agent.storeName ?? undefined}>
                                  {agent.storeName ?? '—'}
                                </span>
                              </td>
                              <td className="px-3 py-3">
                                <AgentStatusDropdown
                                  agent={agent}
                                  onStatusChanged={(status) => patchAgentStatus(agent.id, status)}
                                />
                              </td>
                              <td className="min-w-0 px-3 py-3">
                                <IntegrationPills agent={agent} />
                              </td>
                              <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                                {formatUpdatedAt(agent.updatedAt)}
                              </td>
                              <td className="px-2 py-3">
                                <AgentActionsDropdown
                                  agent={agent}
                                  onDeleteRequest={setDeleteTarget}
                                  onActionEnd={() => void fetchAgents(agents.length > 0 ? 'soft' : 'full')}
                                />
                              </td>
                            </tr>
                            {expanded ? (
                              <tr className="border-b border-border bg-muted/20">
                                <td colSpan={6} className="px-4 py-3">
                                  <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
                                    <span>
                                      Shopify:{' '}
                                      <ConnectionBadge status={agent.shopifyConnectionStatus} />
                                    </span>
                                    <span>
                                      Catalog:{' '}
                                      {agent.catalogReady ? (
                                        <span className="text-emerald-700">Ready ({agent.catalogItemCount} items)</span>
                                      ) : (
                                        <span className="text-amber-700">Not ready</span>
                                      )}
                                    </span>
                                    <span>
                                      Database: <ConnectionBadge status={agent.databaseConnectionStatus} />
                                    </span>
                                    <span>
                                      Twilio: <ConnectionBadge status={agent.twilioConnectionStatus} />
                                    </span>
                                    <span>
                                      OpenAI: <ConnectionBadge status={agent.openaiConnectionStatus} />
                                    </span>
                                    <span>
                                      ElevenLabs: <ConnectionBadge status={agent.elevenlabsConnectionStatus} />
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <Pagination
              page={page}
              totalPages={totalPages}
              totalItems={filtered.length}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
          </div>
        </>
      )}

      <ConfirmDeleteModal
        agentName={deleteTarget?.name ?? ''}
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        loading={deleting}
      />
    </div>
  );
}
