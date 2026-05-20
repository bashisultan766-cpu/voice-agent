import Link from 'next/link';
import { fetchJsonSafe, type AnalyticsOverview } from '@/lib/api/analytics-server';
import { DashboardEmpty, DashboardError } from '@/components/dashboard/DashboardDataMessage';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const result = await fetchJsonSafe<AnalyticsOverview>('/api/analytics/overview');

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">Call metrics, resolution rates, and tool health.</p>
        </div>
        <DashboardError title="Could not load analytics" message={result.error} />
      </div>
    );
  }

  const overview = result.data;
  const avgSec = Math.round(overview.avgDurationSeconds ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">Call metrics, resolution rates, and tool health.</p>
        </div>
        <div className="rounded-md bg-muted px-3 py-1.5 text-sm text-muted-foreground">Live metrics</div>
      </div>

      {overview.totalCalls === 0 ? (
        <DashboardEmpty
          title="No call data yet"
          description="Once your agents handle voice sessions, aggregate metrics will appear here."
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Total calls</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{overview.totalCalls}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Resolution rate</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{overview.resolutionRate}%</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Escalation rate</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{overview.escalationRate}%</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Avg duration</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {Math.floor(avgSec / 60)}m {avgSec % 60}s
          </p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm font-medium text-muted-foreground">Callback requests</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{overview.callbackRequestCount}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Link
          href="/dashboard/analytics/agents"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">Agent metrics</h2>
          <p className="mt-1 text-sm text-muted-foreground">Resolution and escalation by agent.</p>
        </Link>
        <Link
          href="/dashboard/analytics/stores"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">Store metrics</h2>
          <p className="mt-1 text-sm text-muted-foreground">Busiest stores, resolution by store.</p>
        </Link>
        <Link
          href="/dashboard/analytics/tools"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">Tool health</h2>
          <p className="mt-1 text-sm text-muted-foreground">Success rate and latency per tool.</p>
        </Link>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <h2 className="font-medium">QA review</h2>
        <p className="mt-1 text-sm text-muted-foreground">Review call transcripts and submit QA scores.</p>
        <Link href="/dashboard/qa" className="mt-3 inline-block text-sm font-medium text-violet-600 hover:underline dark:text-violet-400">
          Open QA queue →
        </Link>
      </div>
    </div>
  );
}
