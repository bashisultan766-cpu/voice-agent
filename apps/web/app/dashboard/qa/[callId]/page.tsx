import Link from 'next/link';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getServerApiBaseUrl } from '@/lib/server-api-base';
import { getQaCallDetail } from '@/lib/api/analytics-server';

interface QaCallDetailPageProps {
  params: Promise<{ callId: string }>;
}

async function submitQaReview(formData: FormData) {
  'use server';
  const token = (await cookies()).get('va_access_token')?.value;
  const callId = String(formData.get('callId') ?? '');
  if (!token || !callId) return;

  const num = (k: string): number | undefined => {
    const raw = String(formData.get(k) ?? '').trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const res = await fetch(`${getServerApiBaseUrl()}/api/qa/calls/${encodeURIComponent(callId)}/review`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      accuracyScore: num('accuracyScore'),
      toneScore: num('toneScore'),
      policyComplianceScore: num('policyComplianceScore'),
      brevityScore: num('brevityScore'),
      notes: String(formData.get('notes') ?? '').trim() || undefined,
      needsPromptUpdate: formData.get('needsPromptUpdate') === 'on',
      needsFaqUpdate: formData.get('needsFaqUpdate') === 'on',
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to submit QA review.');
  }
  revalidatePath('/dashboard/qa');
  revalidatePath(`/dashboard/qa/${callId}`);
}

export default async function QaCallDetailPage({ params }: QaCallDetailPageProps) {
  const { callId } = await params;
  const call = await getQaCallDetail(callId);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/qa" className="text-sm text-muted-foreground hover:underline">← QA queue</Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Call review</h1>
        <p className="mt-1 text-sm text-muted-foreground font-mono">{callId}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h2 className="font-medium">Summary</h2>
            <p className="mt-2 text-sm text-muted-foreground">{call.summary ?? 'No summary captured.'}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Duration: {Math.floor((call.durationSeconds ?? 0) / 60)}m {(call.durationSeconds ?? 0) % 60}s · Outcome: {call.callOutcome?.resolutionStatus ?? '—'}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h2 className="font-medium">Transcript</h2>
            <ul className="mt-2 space-y-2">
              {call.transcripts.map((t) => (
                <li key={t.sequenceNumber} className={`text-sm ${t.role === 'user' ? 'text-muted-foreground' : ''}`}>
                  <span className="font-medium">{t.role}:</span> {t.content}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h2 className="font-medium">Tool timeline</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {call.toolExecutions.map((ex, i) => (
                <li key={i} className="flex justify-between font-mono text-xs">
                  <span>{ex.toolName}</span>
                  <span className={ex.status === 'SUCCESS' ? 'text-green-600' : 'text-red-600'}>{ex.status} · {ex.latencyMs}ms</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="space-y-4">
          <form action={submitQaReview} className="rounded-lg border bg-card p-4">
            <h2 className="font-medium">QA score</h2>
            <input type="hidden" name="callId" value={callId} />
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-sm text-muted-foreground">Accuracy (0–5)</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  step={0.5}
                  name="accuracyScore"
                  className="mt-1 w-20 rounded border px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground">Tone (0–5)</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  step={0.5}
                  name="toneScore"
                  className="mt-1 w-20 rounded border px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground">Policy compliance (0–5)</label>
                <input type="number" min={0} max={5} step={0.5} name="policyComplianceScore" className="mt-1 w-20 rounded border px-2 py-1 text-sm" />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground">Brevity (0–5)</label>
                <input type="number" min={0} max={5} step={0.5} name="brevityScore" className="mt-1 w-20 rounded border px-2 py-1 text-sm" />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground">Notes</label>
                <textarea
                  name="notes"
                  rows={3}
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  placeholder="Optional notes for this call..."
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="needsPromptUpdate" />
                Needs prompt update
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="needsFaqUpdate" />
                Needs FAQ update
              </label>
            </div>
            <button
              type="submit"
              className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Submit review
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
