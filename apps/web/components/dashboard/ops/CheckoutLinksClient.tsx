'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getOpsCheckoutLinks,
  getOpsPayments,
  type OpsCheckoutLink,
  type OpsPaymentRecord,
} from '@/lib/api/ops';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { FilterSelect } from '@/components/dashboard/ui/FilterSelect';
import { Toolbar } from '@/components/dashboard/ui/Toolbar';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { EmptyState, ErrorState, LoadingState, NoMatchesState, Pagination } from './TableStates';
import { StatusBadge } from './StatusBadge';

const PAGE_SIZE = 20;

export function CheckoutLinksClient() {
  const [rows, setRows] = useState<OpsCheckoutLink[]>([]);
  const [payments, setPayments] = useState<OpsPaymentRecord[]>([]);
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
      const [checkoutRows, paymentRows] = await Promise.all([getOpsCheckoutLinks(), getOpsPayments()]);
      setRows(checkoutRows);
      setPayments(paymentRows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load checkout links.';
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

  const statuses = useMemo(() => Array.from(new Set(rows.map((row) => row.status))).sort(), [rows]);

  const statusOptions = useMemo(() => {
    const base = [{ value: 'all', label: 'All statuses' }];
    return [...base, ...statuses.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))];
  }, [statuses]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return rows.filter((row) => {
      if (agentId !== 'all' && row.agent?.id !== agentId) return false;
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (!q) return true;
      return (
        row.id.toLowerCase().includes(q) ||
        (row.customerEmail?.toLowerCase().includes(q) ?? false) ||
        (row.agent?.name?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, search, statusFilter, agentId]);

  const paymentByCheckoutLinkId = useMemo(() => {
    const map = new Map<string, OpsPaymentRecord>();
    for (const payment of payments) {
      const linkId = payment.checkoutLink?.id;
      if (!linkId) continue;
      const existing = map.get(linkId);
      if (!existing || new Date(payment.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
        map.set(linkId, payment);
      }
    }
    return map;
  }, [payments]);

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
        title="Checkout links"
        description="Secure payment URLs generated for callers — track send status and follow up on abandoned carts."
        actions={
          <Link
            href="/dashboard/email-events"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-muted"
          >
            Email events
          </Link>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search ID, email, agent…" disabled={loading} />
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
        <LoadingState label="Loading checkout links…" variant="table" />
      ) : error && rows.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load('full')} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No checkout links yet"
          description="Run through a voice purchase flow to generate links, or verify Shopify credentials on your agent."
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
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Payment
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Customer
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Shopify order
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Mode
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Created
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Sent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Session
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Link
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paged.map((row) => {
                  const payment = paymentByCheckoutLinkId.get(row.id);
                  return (
                  <tr key={row.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <StatusBadge value={row.status} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge value={payment?.paymentStatus || 'PENDING'} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.customerEmail || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {payment?.shopifyOrderName || payment?.shopifyOrderId || '—'}
                    </td>
                    <td className="px-4 py-3">
                      {row.agent ? (
                        <Link href={`/dashboard/agents/${row.agent.id}`} className="text-violet-600 hover:underline dark:text-violet-400">
                          {row.agent.name}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.mode || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.sentAt ? new Date(row.sentAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.callSessionId ? (
                        <Link
                          href={`/dashboard/transcripts/${row.callSessionId}`}
                          className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                        >
                          Transcript
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap items-center gap-2">
                        <a
                          href={row.checkoutUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                        >
                          Open
                        </a>
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(row.checkoutUrl)}
                          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          Copy URL
                        </button>
                      </span>
                    </td>
                  </tr>
                  );
                })}
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
