import Link from 'next/link';
import { fetchJsonSafe, type AgentMetric } from '@/lib/api/analytics-server';
import { DashboardEmpty, DashboardError } from '@/components/dashboard/DashboardDataMessage';

export const dynamic = 'force-dynamic';

export default async function AnalyticsAgentsPage() {
  const result = await fetchJsonSafe<AgentMetric[]>('/api/analytics/agents');

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <div>
          <Link href="/dashboard/analytics" className="text-sm text-muted-foreground hover:underline">
            ← Analytics
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Agent metrics</h1>
        </div>
        <DashboardError title="Could not load agent metrics" message={result.error} />
      </div>
    );
  }

  const agents = result.data;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/analytics" className="text-sm text-muted-foreground hover:underline">
          ← Analytics
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Agent metrics</h1>
        <p className="mt-1 text-sm text-muted-foreground">Resolution rate, escalation rate, and duration by agent.</p>
      </div>

      {agents.length === 0 ? (
        <DashboardEmpty
          title="No agent metrics yet"
          description="Call data will roll up here after your agents complete sessions."
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="p-3 text-left font-medium">Agent</th>
              <th className="p-3 text-right font-medium">Calls</th>
              <th className="p-3 text-right font-medium">Resolution %</th>
              <th className="p-3 text-right font-medium">Escalation %</th>
              <th className="p-3 text-right font-medium">Avg duration</th>
              <th className="p-3 text-right font-medium">Avg tools</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const sec = Math.round(a.avgDurationSeconds ?? 0);
              return (
                <tr key={a.agentId} className="border-b last:border-0">
                  <td className="p-3 font-medium">{a.agentName}</td>
                  <td className="p-3 text-right tabular-nums">{a.total}</td>
                  <td className="p-3 text-right tabular-nums">{a.resolutionRate}%</td>
                  <td className="p-3 text-right tabular-nums">{a.escalationRate}%</td>
                  <td className="p-3 text-right tabular-nums">
                    {Math.floor(sec / 60)}m {sec % 60}s
                  </td>
                  <td className="p-3 text-right tabular-nums">{a.avgToolCalls}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
