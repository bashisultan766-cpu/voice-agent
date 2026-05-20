import Link from 'next/link';
import { fetchJsonSafe, type StoreMetric } from '@/lib/api/analytics-server';
import { DashboardEmpty, DashboardError } from '@/components/dashboard/DashboardDataMessage';

export const dynamic = 'force-dynamic';

export default async function AnalyticsStoresPage() {
  const result = await fetchJsonSafe<StoreMetric[]>('/api/analytics/stores');

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <div>
          <Link href="/dashboard/analytics" className="text-sm text-muted-foreground hover:underline">
            ← Analytics
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Store metrics</h1>
        </div>
        <DashboardError title="Could not load store metrics" message={result.error} />
      </div>
    );
  }

  const stores = result.data;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/analytics" className="text-sm text-muted-foreground hover:underline">
          ← Analytics
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Store metrics</h1>
        <p className="mt-1 text-sm text-muted-foreground">Call volume and resolution by store.</p>
      </div>

      {stores.length === 0 ? (
        <DashboardEmpty
          title="No store metrics yet"
          description="Assign agents to stores and complete calls to see per-store breakdowns."
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="p-3 text-left font-medium">Store</th>
              <th className="p-3 text-right font-medium">Calls</th>
              <th className="p-3 text-right font-medium">Resolution %</th>
              <th className="p-3 text-right font-medium">Escalation %</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.storeId} className="border-b last:border-0">
                <td className="p-3 font-medium">{s.storeName}</td>
                <td className="p-3 text-right tabular-nums">{s.total}</td>
                <td className="p-3 text-right tabular-nums">{s.resolutionRate}%</td>
                <td className="p-3 text-right tabular-nums">{s.escalationRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
