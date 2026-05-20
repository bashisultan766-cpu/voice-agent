'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { getAgents, deleteAgent, type AgentListItem } from '@/lib/api/agents';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { Pagination } from '@/components/dashboard/ops/TableStates';
import { AgentsDashboardSkeleton } from './AgentsDashboardSkeleton';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { AgentActionsDropdown } from './AgentActionsDropdown';
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

const statusStyles: Record<AgentListItem['status'], string> = {
  active: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  draft: 'bg-slate-50 text-slate-600 border border-slate-200',
  paused: 'bg-slate-50 text-slate-500 border border-slate-200',
};

const connectionStyles: Record<AgentListItem['shopifyConnectionStatus'], string> = {
  ok: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  failed: 'bg-red-50 text-red-600 border border-red-100',
  unknown: 'bg-slate-50 text-slate-500 border border-slate-200',
};

function ConnectionBadge({ status }: { status: AgentListItem['shopifyConnectionStatus'] }) {
  const label = status === 'ok' ? 'Connected' : status === 'failed' ? 'Failed' : '—';
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionStyles[status]}`}>
      {label}
    </span>
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
      <div className="space-y-8">
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
      <div className="space-y-8">
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
    <div className="space-y-8">
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

          <div className={`overflow-hidden rounded-xl border border-border bg-card ${refreshing ? 'opacity-70 transition-opacity' : ''}`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Agent</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Store</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Voice</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Shopify</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Catalog</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Database</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Twilio</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">OpenAI</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">ElevenLabs</th>
                    <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Updated</th>
                    <th className="w-12 px-2 py-3.5" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="px-5 py-14 text-center text-sm text-muted-foreground">
                        No agents match your search or filter.
                      </td>
                    </tr>
                  ) : (
                    paged.map((agent) => (
                      <tr
                        key={agent.id}
                        className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-5 py-3.5">
                          <Link
                            href={`/dashboard/agents/${agent.id}`}
                            className="font-medium text-foreground hover:text-muted-foreground transition-colors"
                            title="View agent details"
                          >
                            {agent.name}
                          </Link>
                        </td>
                        <td className="px-5 py-3.5 text-muted-foreground">{agent.storeName ?? '—'}</td>
                        <td className="px-5 py-3.5 text-muted-foreground">{agent.voice ?? '—'}</td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${statusStyles[agent.status]}`}>
                            {agent.status}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <ConnectionBadge status={agent.shopifyConnectionStatus} />
                        </td>
                        <td className="px-5 py-3.5 text-xs">
                          <span
                            className={`inline-flex rounded-md px-2 py-0.5 font-medium ${
                              agent.catalogReady
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                                : 'bg-amber-50 text-amber-700 border border-amber-100'
                            }`}
                          >
                            {agent.catalogReady ? 'Ready' : 'Not ready'}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <ConnectionBadge status={agent.databaseConnectionStatus} />
                        </td>
                        <td className="px-5 py-3.5">
                          <ConnectionBadge status={agent.twilioConnectionStatus} />
                        </td>
                        <td className="px-5 py-3.5">
                          <ConnectionBadge status={agent.openaiConnectionStatus} />
                        </td>
                        <td className="px-5 py-3.5">
                          <ConnectionBadge status={agent.elevenlabsConnectionStatus} />
                        </td>
                        <td className="px-5 py-3.5 text-muted-foreground">{formatUpdatedAt(agent.updatedAt)}</td>
                        <td className="px-2 py-3.5">
                          <AgentActionsDropdown
                            agent={agent}
                            onDeleteRequest={setDeleteTarget}
                            onActionEnd={() => void fetchAgents(agents.length > 0 ? 'soft' : 'full')}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
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
