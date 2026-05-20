'use client';

import type { ReactNode } from 'react';
import { TableSkeleton } from '@/components/dashboard/ui/TableSkeleton';

export function LoadingState({
  label = 'Loading data...',
  variant = 'simple',
}: {
  label?: string;
  variant?: 'simple' | 'table';
}) {
  if (variant === 'table') {
    return (
      <div className="space-y-3">
        <p className="text-center text-sm text-muted-foreground">{label}</p>
        <TableSkeleton rows={8} cols={6} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-violet-600 border-t-transparent" aria-hidden />
      <p className="mt-4 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

export function NoMatchesState({
  onClear,
}: {
  /** Reset search / filters to defaults */
  onClear?: () => void;
}) {
  return (
    <EmptyState
      title="No matching results"
      description="Nothing matches your search or filters. Try clearing them or using different keywords."
      action={
        onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
          >
            Clear filters
          </button>
        ) : undefined
      }
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/10 px-8 py-16 text-center">
      <div className="rounded-full bg-muted/50 p-3 text-muted-foreground">
        <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20 13V7a2 2 0 00-2-2H6a2 2 0 00-2 2v6m16 0v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4m16 0h-2M4 13h2m3-6V5a1 1 0 011-1h4a1 1 0 011 1v2M7 13h10"
          />
        </svg>
      </div>
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-200/80 bg-red-50/50 px-6 py-10 text-center dark:border-red-900/50 dark:bg-red-950/30">
      <p className="text-sm font-medium text-red-800 dark:text-red-300">Something went wrong</p>
      <p className="mt-2 text-sm text-red-700/90 dark:text-red-200/90">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
      >
        Try again
      </button>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange: (next: number) => void;
}) {
  if (totalPages <= 1) return null;

  const start = totalItems != null && pageSize != null ? Math.min((page - 1) * pageSize + 1, totalItems) : null;
  const end = totalItems != null && pageSize != null ? Math.min(page * pageSize, totalItems) : null;

  return (
    <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        {start != null && end != null ? (
          <>
            Showing <span className="font-medium text-foreground">{start}</span>–
            <span className="font-medium text-foreground">{end}</span> of{' '}
            <span className="font-medium text-foreground">{totalItems}</span>
          </>
        ) : (
          <>
            Page <span className="font-medium text-foreground">{page}</span> of{' '}
            <span className="font-medium text-foreground">{totalPages}</span>
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(1)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-40"
        >
          First
        </button>
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-40"
        >
          Next
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(totalPages)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-40"
        >
          Last
        </button>
      </div>
    </div>
  );
}
