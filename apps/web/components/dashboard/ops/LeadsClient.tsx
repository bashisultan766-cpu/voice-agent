'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getOpsLeads, type OpsLead } from '@/lib/api/ops';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { FilterSelect } from '@/components/dashboard/ui/FilterSelect';
import { Toolbar } from '@/components/dashboard/ui/Toolbar';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { EmptyState, ErrorState, LoadingState, NoMatchesState, Pagination } from './TableStates';
import { StatusBadge } from './StatusBadge';

const PAGE_SIZE = 20;

export function LeadsClient() {
  const [rows, setRows] = useState<OpsLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [agentId, setAgentId] = useState('all');
  const [intentFilter, setIntentFilter] = useState('all');
  const [page, setPage] = useState(1);

  const load = useCallback(async (mode: 'full' | 'soft' = 'full') => {
    const soft = mode === 'soft' && rows.length > 0;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setRows(await getOpsLeads());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load leads.';
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

  const intentOptions = useMemo(() => {
    const intents = Array.from(
      new Set(rows.map((r) => r.intent?.trim()).filter((x): x is string => Boolean(x && x.length > 0))),
    ).sort((a, b) => a.localeCompare(b));
    return [{ value: 'all', label: 'All intents' }, ...intents.map((i) => ({ value: i, label: i }))];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return rows.filter((row) => {
      if (agentId !== 'all' && row.agent?.id !== agentId) return false;
      if (intentFilter !== 'all' && (row.intent?.trim() || '') !== intentFilter) return false;
      if (!q) return true;
      return (
        (row.customerName?.toLowerCase().includes(q) ?? false) ||
        (row.customerEmail?.toLowerCase().includes(q) ?? false) ||
        (row.customerPhone?.toLowerCase().includes(q) ?? false) ||
        (row.intent?.toLowerCase().includes(q) ?? false) ||
        (row.agent?.name?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, search, agentId, intentFilter]);

  useEffect(() => {
    setPage(1);
  }, [search, agentId, intentFilter]);

  const clearFilters = () => {
    setSearch('');
    setAgentId('all');
    setIntentFilter('all');
  };

  const copyText = (value: string) => {
    if (!value.trim()) return;
    void navigator.clipboard.writeText(value);
  };

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        description="Emails, phones, and intents captured during checkout and handoff flows."
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
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search name, email, phone, intent, agent…"
          disabled={loading}
        />
        <FilterSelect
          value={agentId}
          onChange={setAgentId}
          options={agentOptions}
          disabled={loading || rows.length === 0}
        />
        <FilterSelect
          value={intentFilter}
          onChange={setIntentFilter}
          options={intentOptions}
          disabled={loading || rows.length === 0}
        />
        <RefreshButton onClick={() => void load(rows.length > 0 ? 'soft' : 'full')} loading={loading || refreshing} />
      </Toolbar>

      {loading && rows.length === 0 ? (
        <LoadingState label="Loading leads…" variant="table" />
      ) : error && rows.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load('full')} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No leads yet"
          description="When shoppers share contact details on a call, they will show up here for follow-up."
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
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Customer
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Email
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Phone
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Intent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Created
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paged.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium text-foreground">{row.customerName || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.customerEmail ? (
                        <span className="inline-flex items-center gap-2">
                          {row.customerEmail}
                          <button
                            type="button"
                            title="Copy email"
                            onClick={() => copyText(row.customerEmail!)}
                            className="rounded border border-transparent px-1.5 py-0.5 text-xs font-medium text-violet-600 hover:border-violet-200 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-950/40"
                          >
                            Copy
                          </button>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.customerPhone ? (
                        <span className="inline-flex items-center gap-2">
                          {row.customerPhone}
                          <button
                            type="button"
                            title="Copy phone"
                            onClick={() => copyText(row.customerPhone!)}
                            className="rounded border border-transparent px-1.5 py-0.5 text-xs font-medium text-violet-600 hover:border-violet-200 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-950/40"
                          >
                            Copy
                          </button>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">{row.intent ? <StatusBadge value={row.intent} /> : '—'}</td>
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
