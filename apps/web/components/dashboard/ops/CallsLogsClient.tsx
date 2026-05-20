'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getOpsCalls, type OpsCall } from '@/lib/api/ops';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { FilterSelect } from '@/components/dashboard/ui/FilterSelect';
import { Toolbar } from '@/components/dashboard/ui/Toolbar';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { StatusBadge } from './StatusBadge';
import { EmptyState, ErrorState, LoadingState, NoMatchesState, Pagination } from './TableStates';

const PAGE_SIZE = 15;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'INITIATED', label: 'Initiated' },
  { value: 'RINGING', label: 'Ringing' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'ESCALATED', label: 'Escalated' },
  { value: 'ABANDONED', label: 'Abandoned' },
] as const;

export function CallsLogsClient() {
  const [rows, setRows] = useState<OpsCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]['value']>('all');
  const [agentId, setAgentId] = useState('all');
  const [page, setPage] = useState(1);

  const load = useCallback(async (mode: 'full' | 'soft' = 'full') => {
    const soft = mode === 'soft' && rows.length > 0;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await getOpsCalls();
      setRows(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load calls.';
      setError(msg);
      if (!soft) setRows([]);
    } finally {
      if (soft) setRefreshing(false);
      else setLoading(false);
    }
  }, [rows.length]);

  useEffect(() => {
    void load('full');
  }, [load]);

  const agentOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.agent?.id) map.set(row.agent.id, row.agent.name);
    }
    const opts = [...map.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
    return [{ value: 'all', label: 'All agents' }, ...opts];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return rows.filter((row) => {
      if (agentId !== 'all' && row.agent?.id !== agentId) return false;
      if (status !== 'all' && row.status !== status) return false;
      if (!q) return true;
      return (
        row.id.toLowerCase().includes(q) ||
        (row.agent?.name?.toLowerCase().includes(q) ?? false) ||
        (row.fromNumber?.toLowerCase().includes(q) ?? false) ||
        (row.toNumber?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, search, status, agentId]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const paged = filtered.slice(start, start + PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [search, status, agentId]);

  const clearFilters = () => {
    setSearch('');
    setStatus('all');
    setAgentId('all');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Call logs"
        description="Inbound voice sessions with drill-down to transcripts and tooling context."
      />

      <Toolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by call ID, agent, or phone…"
          disabled={loading}
        />
        <FilterSelect
          value={agentId}
          onChange={setAgentId}
          options={agentOptions}
          disabled={loading || rows.length === 0}
        />
        <FilterSelect
          value={status}
          onChange={setStatus}
          options={[...STATUS_OPTIONS]}
          disabled={loading}
        />
        <RefreshButton onClick={() => void load(rows.length > 0 ? 'soft' : 'full')} loading={loading || refreshing} />
      </Toolbar>

      {loading && rows.length === 0 ? (
        <LoadingState label="Loading call logs…" variant="table" />
      ) : error && rows.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load('full')} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No calls yet"
          description="When customers call your agents, each session will appear here with status, duration, and a link to the transcript."
        />
      ) : filtered.length === 0 ? (
        <NoMatchesState onClear={clearFilters} />
      ) : (
        <div
          className={`space-y-3 ${refreshing ? 'opacity-70 transition-opacity' : ''}`}
        >
          {error ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              {error}{' '}
              <button type="button" onClick={() => void load('soft')} className="font-medium underline">
                Retry
              </button>
            </p>
          ) : null}
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    From
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    To
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Duration
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paged.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium text-foreground">{row.agent?.name || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.fromNumber || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.toNumber || '—'}</td>
                    <td className="px-4 py-3">
                      <StatusBadge value={row.status} />
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {row.durationSeconds != null ? `${row.durationSeconds}s` : '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/dashboard/transcripts/${row.id}`}
                          className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                        >
                          Transcript
                        </Link>
                        <button
                          type="button"
                          title="Copy call ID"
                          onClick={() => void navigator.clipboard.writeText(row.id)}
                          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          Copy ID
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
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
        </div>
      )}
    </div>
  );
}
