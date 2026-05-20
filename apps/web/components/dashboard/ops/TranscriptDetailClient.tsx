'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getOpsTranscripts, type OpsTranscript } from '@/lib/api/ops';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { Breadcrumb } from '@/components/dashboard/ui/Breadcrumb';
import { SearchInput } from '@/components/dashboard/ui/SearchInput';
import { FilterSelect } from '@/components/dashboard/ui/FilterSelect';
import { Toolbar } from '@/components/dashboard/ui/Toolbar';
import { RefreshButton } from '@/components/dashboard/ui/RefreshButton';
import { EmptyState, ErrorState, LoadingState, NoMatchesState } from './TableStates';
import { StatusBadge } from './StatusBadge';

const ROLE_OPTIONS = [
  { value: 'all', label: 'All roles' },
  { value: 'user', label: 'User' },
  { value: 'agent', label: 'Agent' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'system', label: 'System' },
  { value: 'tool', label: 'Tool' },
] as const;

function bubbleClass(role: string): string {
  const r = role.toLowerCase();
  if (r === 'user') return 'border-violet-200 bg-violet-50/80 dark:border-violet-900 dark:bg-violet-950/40';
  if (r === 'agent' || r === 'assistant')
    return 'border-slate-200 bg-slate-50/90 dark:border-zinc-700 dark:bg-zinc-900/50';
  if (r === 'tool') return 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30';
  return 'border-border bg-muted/30';
}

export function TranscriptDetailClient({ callId }: { callId: string }) {
  const [rows, setRows] = useState<OpsTranscript[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<(typeof ROLE_OPTIONS)[number]['value']>('all');
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await getOpsTranscripts(callId);
      setRows(data);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : 'Failed to load transcript.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [callId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    let list = rows;
    if (roleFilter !== 'all') {
      list = list.filter((row) => {
        const r = row.role.toLowerCase();
        if (roleFilter === 'agent') return r === 'agent' || r === 'assistant';
        return r === roleFilter;
      });
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((row) => row.content.toLowerCase().includes(q));
  }, [rows, roleFilter, search]);

  const clearFilters = () => {
    setSearch('');
    setRoleFilter('all');
  };

  const copyId = () => {
    void navigator.clipboard.writeText(callId);
  };

  return (
    <div className="space-y-6">
      <Breadcrumb
        items={[
          { label: 'Transcripts', href: '/dashboard/transcripts' },
          { label: 'Session detail' },
        ]}
      />

      <PageHeader
        title="Transcript"
        description="Full timeline for this call session. Use filters to focus on customer vs. model turns."
        actions={
          <button
            type="button"
            onClick={copyId}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-muted"
          >
            Copy session ID
          </button>
        }
      />

      <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 font-mono text-xs text-muted-foreground break-all">
        {callId}
      </div>

      <Toolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search within messages…"
          className="sm:max-w-lg"
          disabled={loading}
        />
        <FilterSelect value={roleFilter} onChange={setRoleFilter} options={[...ROLE_OPTIONS]} disabled={loading} />
        <RefreshButton onClick={() => void load(true)} loading={refreshing} />
        <Link
          href="/dashboard/calls"
          className="text-sm font-medium text-violet-600 hover:underline dark:text-violet-400 sm:ml-auto"
        >
          ← Back to calls
        </Link>
      </Toolbar>

      {loading && !refreshing ? (
        <LoadingState label="Loading transcript…" variant="table" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load(false)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No messages yet"
          description="No transcript lines were stored for this session. If the call just ended, wait a moment and refresh."
        />
      ) : filtered.length === 0 ? (
        <NoMatchesState onClear={clearFilters} />
      ) : (
        <div className="space-y-3">
          {filtered.map((row) => (
            <div
              key={row.id}
              className={`rounded-xl border p-4 shadow-sm ${bubbleClass(row.role)}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge value={row.role} />
                  <span className="text-xs text-muted-foreground">#{row.sequenceNumber}</span>
                </div>
                <time className="text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</time>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{row.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
