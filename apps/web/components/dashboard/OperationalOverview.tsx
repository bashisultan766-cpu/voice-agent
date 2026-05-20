'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getAgents, type AgentListItem } from '@/lib/api/agents';
import {
  getOpsCalls,
  getOpsLeads,
  getOpsCheckoutLinks,
  getOpsEmailEvents,
  getOpsPayments,
  type OpsCall,
} from '@/lib/api/ops';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { EmptyState, LoadingState, ErrorState } from '@/components/dashboard/ops/TableStates';
import { StatusBadge } from '@/components/dashboard/ops/StatusBadge';

function StatCard({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border border-border bg-card p-5 shadow-sm transition-all hover:border-violet-500/30 hover:shadow-md"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-2 text-xs text-muted-foreground group-hover:text-foreground/80">{hint}</p>}
    </Link>
  );
}

export function OperationalOverview() {
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [calls, setCalls] = useState<OpsCall[] | null>(null);
  const [leadsCount, setLeadsCount] = useState(0);
  const [checkoutsCount, setCheckoutsCount] = useState(0);
  const [emailEventsCount, setEmailEventsCount] = useState(0);
  const [paidOrdersCount, setPaidOrdersCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setBootstrapped(false);
    setError(null);
    try {
      const [a, c, leads, checkouts, emails, payments] = await Promise.all([
        getAgents(),
        getOpsCalls(),
        getOpsLeads(),
        getOpsCheckoutLinks(),
        getOpsEmailEvents(),
        getOpsPayments(),
      ]);
      setAgents(a);
      setCalls(c);
      setLeadsCount(leads.length);
      setCheckoutsCount(checkouts.length);
      setEmailEventsCount(emails.length);
      setPaidOrdersCount(payments.filter((p) => p.paymentStatus === 'PAID').length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load overview.');
      setAgents([]);
      setCalls([]);
      setLeadsCount(0);
      setCheckoutsCount(0);
      setEmailEventsCount(0);
      setPaidOrdersCount(0);
    } finally {
      setBootstrapped(true);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const activeAgents = agents?.filter((x) => x.status === 'active').length ?? 0;
  const recentCalls =
    calls?.filter((c) => {
      const t = new Date(c.createdAt).getTime();
      return Date.now() - t < 7 * 24 * 60 * 60 * 1000;
    }).length ?? 0;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Operations"
        description="Monitor agents, calls, and revenue-adjacent flows across your workspace."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <RefreshButton onClick={() => void load(true)} loading={refreshing} />
            <Link
              href="/dashboard/agents/new"
              className="rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2"
            >
              New agent
            </Link>
          </div>
        }
      />

      {!bootstrapped && !refreshing ? (
        <LoadingState label="Loading dashboard…" variant="table" />
      ) : error && !agents?.length && !calls?.length && leadsCount === 0 && checkoutsCount === 0 && emailEventsCount === 0 && paidOrdersCount === 0 ? (
        <ErrorState message={error} onRetry={() => void load(false)} />
      ) : (
        <>
          {error && (
            <p className="rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {error}
            </p>
          )}
          {bootstrapped && (agents?.length ?? 0) === 0 ? (
            <EmptyState
              title="No agents in this workspace yet"
              description="Create a voice agent to connect Shopify, Twilio, and your knowledge base. Stats below will populate as callers interact with your store."
              action={
                <Link
                  href="/dashboard/agents/new"
                  className="inline-flex rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-violet-700"
                >
                  Create your first agent
                </Link>
              }
            />
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard
              label="Voice agents"
              value={agents?.length ?? 0}
              hint={`${activeAgents} active`}
              href="/dashboard/agents"
            />
            <StatCard
              label="Call sessions"
              value={calls?.length ?? 0}
              hint={`${recentCalls} in last 7 days`}
              href="/dashboard/calls"
            />
            <StatCard label="Leads captured" value={leadsCount} hint="From voice conversations" href="/dashboard/leads" />
            <StatCard
              label="Checkout links"
              value={checkoutsCount}
              hint="Generated payment links"
              href="/dashboard/checkout-links"
            />
            <StatCard
              label="Email events"
              value={emailEventsCount}
              hint="Payment link delivery"
              href="/dashboard/email-events"
            />
            <StatCard
              label="Paid orders"
              value={paidOrdersCount}
              hint="Shopify webhook confirmed"
              href="/dashboard/checkout-links"
            />
          </div>

          {calls != null && calls.length > 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-foreground">Recent call sessions</h2>
                <Link href="/dashboard/calls" className="text-sm font-medium text-violet-600 hover:underline dark:text-violet-400">
                  View all →
                </Link>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="pb-2 pr-4">Agent</th>
                      <th className="pb-2 pr-4">From</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">When</th>
                      <th className="pb-2"> </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {[...calls]
                      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                      .slice(0, 6)
                      .map((row) => (
                        <tr key={row.id}>
                          <td className="py-2.5 pr-4 font-medium text-foreground">{row.agent?.name ?? '—'}</td>
                          <td className="py-2.5 pr-4 text-muted-foreground">{row.fromNumber ?? '—'}</td>
                          <td className="py-2.5 pr-4">
                            <StatusBadge value={row.status} />
                          </td>
                          <td className="py-2.5 pr-4 text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</td>
                          <td className="py-2.5">
                            <Link
                              href={`/dashboard/transcripts/${row.id}`}
                              className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                            >
                              Transcript
                            </Link>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : bootstrapped && (agents?.length ?? 0) > 0 ? (
            <p className="text-sm text-muted-foreground">No call sessions recorded yet. They will appear here and under Call logs once customers reach your agents.</p>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground">Quick actions</h2>
              <ul className="mt-4 space-y-2 text-sm">
                <li>
                  <Link href="/dashboard/agents/health" className="text-violet-600 hover:underline dark:text-violet-400">
                    Agent health & errors
                  </Link>
                  <span className="text-muted-foreground"> — pause, resume, test integrations</span>
                </li>
                <li>
                  <Link href="/dashboard/transcripts" className="text-violet-600 hover:underline dark:text-violet-400">
                    Transcripts
                  </Link>
                  <span className="text-muted-foreground"> — review conversation quality</span>
                </li>
                <li>
                  <Link href="/dashboard/email-events" className="text-violet-600 hover:underline dark:text-violet-400">
                    Email events
                  </Link>
                  <span className="text-muted-foreground"> — payment link delivery</span>
                </li>
                <li>
                  <Link href="/dashboard/readiness" className="text-violet-600 hover:underline dark:text-violet-400">
                    Pre-launch checklist
                  </Link>
                </li>
              </ul>
            </div>
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground">Recent agents</h2>
              {!agents?.length ? (
                <p className="mt-4 text-sm text-muted-foreground">No agents yet. Create one to get started.</p>
              ) : (
                <ul className="mt-4 divide-y divide-border">
                  {[...agents]
                    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                    .slice(0, 5)
                    .map((a) => (
                      <li key={a.id} className="flex items-center justify-between py-3 first:pt-0">
                        <Link href={`/dashboard/agents/${a.id}`} className="font-medium text-foreground hover:text-violet-600">
                          {a.name}
                        </Link>
                        <span className="text-xs capitalize text-muted-foreground">{a.status}</span>
                      </li>
                    ))}
                </ul>
              )}
              <Link
                href="/dashboard/agents"
                className="mt-4 inline-block text-sm font-medium text-violet-600 hover:underline dark:text-violet-400"
              >
                View all agents →
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
