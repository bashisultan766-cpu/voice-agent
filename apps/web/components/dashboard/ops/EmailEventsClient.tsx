'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getOpsEmailEvents, type OpsEmailEvent } from '@/lib/api/ops';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { FilterSelect } from '@/components/dashboard/ui/FilterSelect';
import { Toolbar } from '@/components/dashboard/ui/Toolbar';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { EmptyState, ErrorState, LoadingState, NoMatchesState, Pagination } from './TableStates';
import { StatusBadge } from './StatusBadge';

const PAGE_SIZE = 20;

export function EmailEventsClient() {
  const [rows, setRows] = useState<OpsEmailEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [agentId, setAgentId] = useState('all');
  const [page, setPage] = useState(1);

  const load = useCallback(async (mode: 'full' | 'soft' = 'full') => {
    const soft = mode === 'soft' && rows.length > 0;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setRows(await getOpsEmailEvents());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load email events.';
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

  const statuses = useMemo(() => Array.from(new Set(rows.map((row) => row.status))).sort(), [rows]);

  const statusOptions = useMemo(() => {
    const base = [{ value: 'all', label: 'All statuses' }];
    return [...base, ...statuses.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))];
  }, [statuses]);

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
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (!q) return true;
      return (
        row.recipientEmail.toLowerCase().includes(q) ||
        row.subject.toLowerCase().includes(q) ||
        (row.agent?.name?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, search, statusFilter, agentId]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, agentId]);

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('all');
    setAgentId('all');
  };

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email events"
        description="Resend delivery pipeline for payment-link emails — spot failures and duplicates early."
        actions={
          <Link
            href="/dashboard/checkout-links"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-muted"
          >
            Checkout links
          </Link>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Recipient, subject, agent…" disabled={loading} />
        <FilterSelect
          value={agentId}
          onChange={setAgentId}
          options={agentOptions}
          disabled={loading || rows.length === 0}
        />
        <FilterSelect
          value={statusFilter}
          onChange={setStatusFilter}
          options={statusOptions as { value: string; label: string }[]}
          disabled={loading}
        />
        <RefreshButton onClick={() => void load(rows.length > 0 ? 'soft' : 'full')} loading={loading || refreshing} />
      </Toolbar>

      {loading && rows.length === 0 ? (
        <LoadingState label="Loading email events…" variant="table" />
      ) : error && rows.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load('full')} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No email events yet"
          description="When agents email checkout links to shoppers, each send and its delivery state will appear here."
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
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Recipient
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Subject
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Provider
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Created
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Sent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paged.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium text-foreground">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {row.recipientEmail}
                        <button
                          type="button"
                          title="Copy recipient"
                          onClick={() => void navigator.clipboard.writeText(row.recipientEmail)}
                          className="rounded border border-transparent px-1.5 py-0.5 text-xs font-medium text-violet-600 hover:border-violet-200 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-950/40"
                        >
                          Copy
                        </button>
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-muted-foreground" title={row.subject}>
                      {row.subject}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge value={row.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.provider || 'resend'}</td>
                    <td className="px-4 py-3">
                      {row.agent ? (
                        <Link href={`/dashboard/agents/${row.agent.id}`} className="text-violet-600 hover:underline dark:text-violet-400">
                          {row.agent.name}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.sentAt ? new Date(row.sentAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {row.callSessionId ? (
                        <Link
                          href={`/dashboard/transcripts/${row.callSessionId}`}
                          className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                        >
                          Transcript
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
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
