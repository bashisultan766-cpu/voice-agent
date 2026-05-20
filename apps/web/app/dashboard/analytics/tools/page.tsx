import Link from 'next/link';
import { fetchJsonSafe, type ToolMetric } from '@/lib/api/analytics-server';
import { DashboardEmpty, DashboardError } from '@/components/dashboard/DashboardDataMessage';

export const dynamic = 'force-dynamic';

export default async function AnalyticsToolsPage() {
  const result = await fetchJsonSafe<ToolMetric[]>('/api/analytics/tools');

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <div>
          <Link href="/dashboard/analytics" className="text-sm text-muted-foreground hover:underline">
            ← Analytics
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Tool health</h1>
        </div>
        <DashboardError title="Could not load tool metrics" message={result.error} />
      </div>
    );
  }

  const tools = result.data;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/analytics" className="text-sm text-muted-foreground hover:underline">
          ← Analytics
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Tool health</h1>
        <p className="mt-1 text-sm text-muted-foreground">Success rate and latency per tool.</p>
      </div>

      {tools.length === 0 ? (
        <DashboardEmpty
          title="No tool executions yet"
          description="When the voice agent invokes tools during calls, success rates and latency will show here."
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="p-3 text-left font-medium">Tool</th>
              <th className="p-3 text-right font-medium">Calls</th>
              <th className="p-3 text-right font-medium">Success %</th>
              <th className="p-3 text-right font-medium">Avg latency (ms)</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.toolName} className="border-b last:border-0">
                <td className="p-3 font-mono text-xs font-medium">{t.toolName}</td>
                <td className="p-3 text-right tabular-nums">{t.totalCalls}</td>
                <td className="p-3 text-right tabular-nums">
                  <span
                    className={
                      t.successRate >= 95
                        ? 'text-emerald-600'
                        : t.successRate >= 80
                          ? 'text-amber-600'
                          : 'text-red-600'
                    }
                  >
                    {t.successRate}%
                  </span>
                </td>
                <td className="p-3 text-right tabular-nums">{t.avgLatencyMs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
