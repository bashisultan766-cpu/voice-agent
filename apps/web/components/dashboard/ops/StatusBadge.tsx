'use client';

type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

const toneClasses: Record<Tone, string> = {
  success: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  warning: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800',
  error: 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  neutral: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-300 dark:border-zinc-700',
  info: 'bg-violet-50 text-violet-800 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800',
};

function classifyStatus(value: string): Tone {
  const s = value.toLowerCase().replace(/\s+/g, '_');
  if (['active', 'ready', 'completed', 'sent', 'delivered', 'ok', 'healthy', 'clicked', 'paid'].includes(s)) return 'success';
  if (['paused', 'draft', 'queued', 'ringing', 'initiated', 'unknown', 'created', 'pending'].includes(s)) return 'warning';
  if (['failed', 'error', 'disabled', 'bounced', 'abandoned', 'issues'].includes(s)) return 'error';
  if (['in_progress', 'opened', 'escalated'].includes(s)) return 'info';
  return 'neutral';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

export function StatusBadge({ value }: { value: string }) {
  const tone = classifyStatus(value);
  return (
    <span
      className={`inline-flex max-w-full truncate rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${toneClasses[tone]}`}
      title={value}
    >
      {formatLabel(value)}
    </span>
  );
}
