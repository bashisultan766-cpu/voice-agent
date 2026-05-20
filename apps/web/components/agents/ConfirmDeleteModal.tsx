'use client';

import { useEffect, useCallback } from 'react';

interface ConfirmDeleteModalProps {
  agentName: string;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
}

export function ConfirmDeleteModal({
  agentName,
  open,
  onClose,
  onConfirm,
  loading = false,
}: ConfirmDeleteModalProps) {
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onClose();
    },
    [onClose, loading],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, handleEscape]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
        className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg focus:outline-none"
        tabIndex={-1}
      >
        <h2 id="delete-modal-title" className="text-base font-medium text-foreground">
          Delete agent
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Are you sure you want to delete <strong className="font-medium text-foreground">{agentName}</strong>? This cannot be undone.
        </p>
        <div className="mt-8 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-lg border border-red-200 bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-red-200 focus:ring-offset-2"
          >
            {loading ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
