import Link from 'next/link';
import { fetchJsonSafe, type QaQueueCall } from '@/lib/api/analytics-server';
import { DashboardEmpty, DashboardError } from '@/components/dashboard/DashboardDataMessage';

export const dynamic = 'force-dynamic';

export default async function QaPage() {
  const result = await fetchJsonSafe<QaQueueCall[]>('/api/qa/calls?limit=50');

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">QA review</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review call transcripts and submit QA scores. Flag calls for prompt or FAQ updates.
          </p>
        </div>
        <DashboardError title="Could not load QA queue" message={result.error} />
      </div>
    );
  }

  const calls = result.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">QA review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review call transcripts and submit QA scores. Flag calls for prompt or FAQ updates.
        </p>
      </div>

      {calls.length === 0 ? (
        <DashboardEmpty
          title="QA queue is empty"
          description="Completed calls with transcripts will appear here for scoring and training feedback."
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="p-3 text-left font-medium">Call</th>
                <th className="p-3 text-left font-medium">Agent / Store</th>
                <th className="p-3 text-left font-medium">Status</th>
                <th className="p-3 text-right font-medium">Tools</th>
                <th className="p-3 text-right font-medium">Outcome</th>
                <th className="p-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="p-3 font-mono text-xs">{c.id.slice(0, 8)}…</td>
                  <td className="p-3">
                    {c.agent.name} / {c.store?.name ?? 'Unassigned store'}
                  </td>
                  <td className="p-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        c.status === 'COMPLETED'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="p-3 text-right tabular-nums">{c._count.toolExecutions}</td>
                  <td className="p-3 text-right text-muted-foreground">{c.callOutcome?.resolutionStatus ?? '—'}</td>
                  <td className="p-3 text-right">
                    <Link
                      href={`/dashboard/qa/${c.id}`}
                      className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                    >
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
