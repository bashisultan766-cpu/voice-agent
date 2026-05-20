'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getOpsCalls, type OpsCall } from '@/lib/api/ops';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { FilterSelect } from '@/components/dashboard/ui/FilterSelect';
import { Toolbar } from '@/components/dashboard/ui/Toolbar';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { EmptyState, ErrorState, LoadingState, NoMatchesState, Pagination } from './TableStates';
import { StatusBadge } from './StatusBadge';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'ESCALATED', label: 'Escalated' },
] as const;

export function TranscriptsIndexClient() {
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
      const msg = err instanceof Error ? err.message : 'Failed to load transcripts list.';
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
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (agentId !== 'all' && row.agent?.id !== agentId) return false;
      if (status !== 'all' && row.status !== status) return false;
      if (!q) return true;
      return (
        row.id.toLowerCase().includes(q) ||
        (row.agent?.name?.toLowerCase().includes(q) ?? false) ||
        (row.fromNumber?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, search, status, agentId]);

  useEffect(() => {
    setPage(1);
  }, [search, status, agentId]);

  const clearFilters = () => {
    setSearch('');
    setStatus('all');
    setAgentId('all');
  };

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transcripts"
        description="Browse call sessions and open the full message timeline for QA or training."
      />

      <Toolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by call ID, agent, or caller…"
          disabled={loading}
        />
        <FilterSelect
          value={agentId}
          onChange={setAgentId}
          options={agentOptions}
          disabled={loading || rows.length === 0}
        />
        <FilterSelect value={status} onChange={setStatus} options={[...STATUS_OPTIONS]} disabled={loading} />
        <RefreshButton onClick={() => void load(rows.length > 0 ? 'soft' : 'full')} loading={loading || refreshing} />
      </Toolbar>

      {loading && rows.length === 0 ? (
        <LoadingState label="Loading transcript sessions…" variant="table" />
      ) : error && rows.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load('full')} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No transcript sessions yet"
          description="Once customers call your agents, sessions will appear here. Open any row to read the full message timeline."
        />
      ) : filtered.length === 0 ? (
        <NoMatchesState onClear={clearFilters} />
      ) : (
        <div className={`space-y-3 ${refreshing ? 'opacity-70 transition-opacity' : ''}`}>
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
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Call ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Caller
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paged.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.id.slice(0, 14)}…</td>
                    <td className="px-4 py-3 font-medium text-foreground">{row.agent?.name || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.fromNumber || '—'}</td>
                    <td className="px-4 py-3">
                      <StatusBadge value={row.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/transcripts/${row.id}`}
                        className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                      >
                        Open
                      </Link>
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
