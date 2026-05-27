'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  getOpsAgents,
  runOpsFullReadinessSmoke,
  type OpsAgentOverview,
  type OpsFullReadinessSmokeResponse,
} from '@/lib/api/ops';
import {
  testAgentConnection,
  updateAgent,
  goLiveAgent,
  formatAgentStatusFailureMessage,
} from '@/lib/api/agents';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { FilterSelect } from '@/components/dashboard/ui/FilterSelect';
import { Toolbar } from '@/components/dashboard/ui/Toolbar';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { EmptyState, ErrorState, LoadingState, NoMatchesState, Pagination } from './TableStates';
import { StatusBadge } from './StatusBadge';

const PAGE_SIZE = 15;

const HEALTH_FILTER = [
  { value: 'all', label: 'All agents' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'issues', label: 'Needs attention' },
] as const;

export function AgentHealthClient() {
  const { addToast } = useToast();
  const [rows, setRows] = useState<OpsAgentOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<(typeof HEALTH_FILTER)[number]['value']>('all');
  const [page, setPage] = useState(1);
  const [actionState, setActionState] = useState<Record<string, string>>({});
  const [smokeResultByAgentId, setSmokeResultByAgentId] = useState<
    Record<string, OpsFullReadinessSmokeResponse>
  >({});
  const [expandedSmokeAgentId, setExpandedSmokeAgentId] = useState<string | null>(null);

  const load = useCallback(async (mode: 'full' | 'soft' = 'full') => {
    const soft = mode === 'soft' && rows.length > 0;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setRows(await getOpsAgents());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load agent health data.';
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

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('all');
  };

  const isHealthy = useCallback(
    (row: OpsAgentOverview) =>
      [row.shopifyConnectionStatus, row.twilioConnectionStatus, row.openaiConnectionStatus].every(
        (s) => (s || 'UNKNOWN') === 'OK',
      ),
    [],
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return rows.filter((row) => {
      if (statusFilter === 'healthy' && !isHealthy(row)) return false;
      if (statusFilter === 'issues' && isHealthy(row)) return false;
      if (!q) return true;
      return row.name.toLowerCase().includes(q) || row.id.toLowerCase().includes(q);
    });
  }, [rows, search, statusFilter, isHealthy]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const setBusy = (id: string, state: string | null) => {
    setActionState((prev) => {
      const next = { ...prev };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });
  };

  const handleToggle = async (row: OpsAgentOverview) => {
    const next = row.status === 'ACTIVE' ? 'paused' : 'active';
    setBusy(row.id, 'toggle');
    try {
      if (next === 'active') {
        const result = await goLiveAgent(row.id);
        if (!result.ready) {
          addToast('error', formatAgentStatusFailureMessage(result.failures));
          return;
        }
        addToast('success', 'Agent resumed and is live.');
      } else {
        await updateAgent(row.id, { agentStatus: 'paused' });
        addToast('success', 'Agent paused.');
      }
      await load('soft');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Could not update agent.');
    } finally {
      setBusy(row.id, null);
    }
  };

  const handleTest = async (id: string) => {
    setBusy(id, 'test');
    try {
      const results = await Promise.allSettled([
        testAgentConnection(id, 'shopify'),
        testAgentConnection(id, 'twilio'),
        testAgentConnection(id, 'openai'),
      ]);
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed === 0) addToast('success', 'Integration tests finished. Review statuses below.');
      else addToast('error', `${failed} test(s) failed — open the agent or check API credentials.`);
      await load('soft');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Tests failed.');
    } finally {
      setBusy(id, null);
    }
  };

  const handleFullSmoke = async (id: string) => {
    setBusy(id, 'smoke');
    try {
      const result = await runOpsFullReadinessSmoke(id, { runFlowSimulation: false });
      setSmokeResultByAgentId((prev) => ({ ...prev, [id]: result }));
      setExpandedSmokeAgentId(id);
      addToast(
        result.ok ? 'success' : 'error',
        result.ok
          ? 'Full readiness smoke passed.'
          : `Full smoke found ${result.summary.failed} issue(s).`,
      );
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Full readiness smoke failed.');
    } finally {
      setBusy(id, null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent health"
        description="Connection posture across Shopify, Twilio, and OpenAI. Pause agents during incidents or re-test after rotating keys."
        actions={
          <Link
            href="/dashboard/agents"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-muted"
          >
            All agents
          </Link>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search agents…" disabled={loading} />
        <FilterSelect value={statusFilter} onChange={setStatusFilter} options={[...HEALTH_FILTER]} disabled={loading} />
        <RefreshButton onClick={() => void load(rows.length > 0 ? 'soft' : 'full')} loading={loading || refreshing} />
      </Toolbar>

      {loading && rows.length === 0 ? (
        <LoadingState label="Loading agent health…" variant="table" />
      ) : error && rows.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load('full')} />
      ) : rows.length === 0 ? (
        <EmptyState title="No agents yet" description="Create an agent to see health signals and operational controls here." />
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
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Shopify
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Twilio
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    OpenAI
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Rollup
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Updated
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paged.map((row) => {
                  const busy = actionState[row.id] || null;
                  const healthy = isHealthy(row);
                  const smoke = smokeResultByAgentId[row.id] ?? null;
                  const isExpanded = expandedSmokeAgentId === row.id && smoke !== null;
                  return (
                    <Fragment key={row.id}>
                      <tr className="hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <Link
                            className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                            href={`/dashboard/agents/${row.id}`}
                          >
                            {row.name}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge value={row.status} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge value={row.shopifyConnectionStatus || 'UNKNOWN'} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge value={row.twilioConnectionStatus || 'UNKNOWN'} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge value={row.openaiConnectionStatus || 'UNKNOWN'} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge value={healthy ? 'HEALTHY' : 'ISSUES'} />
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{new Date(row.updatedAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleToggle(row)}
                              disabled={!!busy}
                              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-50"
                            >
                              {busy === 'toggle'
                                ? 'Updating…'
                                : row.status === 'ACTIVE'
                                  ? 'Pause'
                                  : 'Resume'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleTest(row.id)}
                              disabled={!!busy}
                              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-50"
                            >
                              {busy === 'test' ? 'Testing…' : 'Test config'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleFullSmoke(row.id)}
                              disabled={!!busy}
                              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-50"
                            >
                              {busy === 'smoke' ? 'Running…' : 'Full smoke'}
                            </button>
                            {smoke ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedSmokeAgentId((prev) => (prev === row.id ? null : row.id))
                                }
                                className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted"
                              >
                                {isExpanded ? 'Hide checks' : 'Show checks'}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr>
                          <td colSpan={8} className="bg-muted/10 px-4 py-3">
                            <div className="rounded-xl border border-border bg-card p-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm font-semibold">
                                  Full readiness smoke: {smoke.agentName}
                                </p>
                                <span
                                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                                    smoke.ok
                                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                                      : 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200'
                                  }`}
                                >
                                  {smoke.summary.passed} passed / {smoke.summary.failed} failed
                                </span>
                              </div>
                              <p className="mt-2 text-xs text-muted-foreground">
                                Expected Twilio inbound webhook: {smoke.expectedTwilioWebhook.inbound}
                              </p>
                              <div className="mt-3 grid gap-2 md:grid-cols-2">
                                {smoke.checks.map((check) => (
                                  <div
                                    key={check.key}
                                    className={`rounded-lg border px-3 py-2 ${
                                      check.pass
                                        ? 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-900/40 dark:bg-emerald-950/20'
                                        : 'border-rose-200 bg-rose-50/80 dark:border-rose-900/40 dark:bg-rose-950/20'
                                    }`}
                                  >
                                    <p className="text-xs font-semibold">
                                      {check.pass ? 'PASS' : 'FAIL'}: {check.key}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground">{check.details}</p>
                                  </div>
                                ))}
                              </div>
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
