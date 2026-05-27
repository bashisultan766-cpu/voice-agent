'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AgentListItem } from '@/lib/api/agents';
import {
  getAgent,
  createAgent,
  updateAgent,
  goLiveAgent,
  formatAgentStatusFailureMessage,
  agentToFormData,
  testAgentConnection,
  syncAgentSecretsFromSettings,
} from '@/lib/api/agents';
import { useToast } from '@/components/ui/Toast';

interface AgentActionsDropdownProps {
  agent: AgentListItem;
  onDeleteRequest: (agent: AgentListItem) => void;
  onActionEnd?: () => void;
}

export function AgentActionsDropdown({
  agent,
  onDeleteRequest,
  onActionEnd,
}: AgentActionsDropdownProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const router = useRouter();
  const { addToast } = useToast();

  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setMenuPos(null);
      return;
    }
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    const width = Math.max(180, rect.width);
    setMenuPos({
      top: rect.bottom + 6,
      left: rect.right - width,
      width,
    });
  }, [open]);

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    if (!open) return;
    const t = window.setTimeout(() => {
      document.addEventListener('pointerdown', handlePointerDown, true);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open]);

  const handleView = () => {
    setOpen(false);
    router.push(`/dashboard/agents/${agent.id}`);
  };

  const handleEdit = () => {
    setOpen(false);
    router.push(`/dashboard/agents/${agent.id}/edit`);
  };

  const handleDuplicate = async () => {
    setOpen(false);
    setLoading('duplicate');
    try {
      const full = await getAgent(agent.id);
      if (!full) return;
      const payload = agentToFormData(full);
      await createAgent({
        ...payload,
        agentName: `${payload.agentName} (Copy)`,
        agentStatus: 'draft',
      });
      onActionEnd?.();
      router.refresh();
    } finally {
      setLoading(null);
    }
  };

  const handlePause = async () => {
    setOpen(false);
    setLoading('pause');
    try {
      await updateAgent(agent.id, { agentStatus: 'paused' });
      onActionEnd?.();
      router.refresh();
    } finally {
      setLoading(null);
    }
  };

  const handleActivate = async () => {
    setOpen(false);
    setLoading('activate');
    try {
      const result = await goLiveAgent(agent.id);
      if (result.ready) {
        addToast('success', 'Agent is live and can receive calls.');
      } else {
        addToast('error', formatAgentStatusFailureMessage(result.failures));
      }
      onActionEnd?.();
      router.refresh();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to activate agent.');
    } finally {
      setLoading(null);
    }
  };

  const handleDelete = () => {
    setOpen(false);
    onDeleteRequest(agent);
  };

  const handleTestConfig = async () => {
    setOpen(false);
    setLoading('test');
    try {
      await Promise.allSettled([
        testAgentConnection(agent.id, 'shopify'),
        testAgentConnection(agent.id, 'twilio'),
        testAgentConnection(agent.id, 'openai'),
      ]);
      onActionEnd?.();
      router.refresh();
    } finally {
      setLoading(null);
    }
  };

  const handleSyncSecrets = async () => {
    setOpen(false);
    setLoading('sync-secrets');
    try {
      await syncAgentSecretsFromSettings(agent.id);
      onActionEnd?.();
      router.refresh();
    } finally {
      setLoading(null);
    }
  };

  const isBusy = loading !== null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        disabled={isBusy}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Actions"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
        </svg>
      </button>
      {open && menuPos && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-[200] min-w-[180px] rounded-xl border border-border bg-card py-1 shadow-lg"
              style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            >
          <button
            type="button"
            onClick={handleView}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted/50 transition-colors"
          >
            View
          </button>
          <button
            type="button"
            onClick={handleEdit}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted/50 transition-colors"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleDuplicate}
            disabled={isBusy}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors"
          >
            {loading === 'duplicate' ? 'Duplicating…' : 'Duplicate'}
          </button>
          <button
            type="button"
            onClick={handleTestConfig}
            disabled={isBusy}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors"
          >
            {loading === 'test' ? 'Testing…' : 'Test config'}
          </button>
          <button
            type="button"
            onClick={handleSyncSecrets}
            disabled={isBusy}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors"
          >
            {loading === 'sync-secrets' ? 'Syncing…' : 'Sync secrets from Settings'}
          </button>
          {agent.status !== 'paused' && (
            <button
              type="button"
              onClick={handlePause}
              disabled={isBusy}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors"
            >
              {loading === 'pause' ? 'Updating…' : 'Pause'}
            </button>
          )}
          {agent.status !== 'active' && (
            <button
              type="button"
              onClick={handleActivate}
              disabled={isBusy}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors"
            >
              {loading === 'activate' ? 'Updating…' : 'Activate'}
            </button>
          )}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleDelete}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50/50 transition-colors"
          >
            Delete
          </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
