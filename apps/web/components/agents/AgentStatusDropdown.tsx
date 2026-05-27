'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentListItem } from '@/lib/api/agents';
import {
  formatAgentStatusFailureMessage,
  goLiveAgent,
  mapStatus,
  updateAgentStatus,
  type AgentStatusTransition,
} from '@/lib/api/agents';
import { useToast } from '@/components/ui/Toast';

const statusStyles: Record<AgentListItem['status'], string> = {
  active: 'bg-emerald-50 text-emerald-700 border border-emerald-100 hover:bg-emerald-100/80',
  draft: 'bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100',
  paused: 'bg-amber-50 text-amber-800 border border-amber-100 hover:bg-amber-100/80',
};

const statusLabels: Record<AgentListItem['status'], string> = {
  active: 'Active',
  draft: 'Draft',
  paused: 'Paused',
};

type AgentStatusDropdownProps = {
  agent: AgentListItem;
  onStatusChanged: (next: AgentListItem['status']) => void;
};

export function AgentStatusDropdown({ agent, onStatusChanged }: AgentStatusDropdownProps) {
  const { addToast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setMenuPos(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.max(200, rect.width);
    setMenuPos({
      top: rect.bottom + 6,
      left: Math.max(8, rect.left),
      width,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    const t = window.setTimeout(() => {
      document.addEventListener('pointerdown', handlePointerDown, true);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open]);

  const runTransition = async (status: AgentStatusTransition, successLabel: string) => {
    setOpen(false);
    setLoading(true);
    try {
      if (status === 'active') {
        const result = await goLiveAgent(agent.id);
        if (result.ready) {
          onStatusChanged('active');
          addToast('success', successLabel);
        } else {
          onStatusChanged('paused');
          addToast('error', formatAgentStatusFailureMessage(result.failures));
        }
        return;
      }
      const result = await updateAgentStatus(agent.id, status);
      onStatusChanged(mapStatus(result.agent.status));
      addToast('success', successLabel);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Could not update agent status.');
    } finally {
      setLoading(false);
    }
  };

  const menuItems: Array<{ key: string; label: string; show: boolean; onClick: () => void }> = [
    {
      key: 'live',
      label: agent.status === 'paused' ? 'Resume / Make Live' : 'Make Live / Active',
      show: agent.status !== 'active',
      onClick: () => void runTransition('active', 'Agent is live and can receive calls.'),
    },
    {
      key: 'pause',
      label: 'Pause Agent',
      show: agent.status === 'active',
      onClick: () => void runTransition('paused', 'Agent paused.'),
    },
    {
      key: 'draft',
      label: 'Set Draft',
      show: agent.status !== 'draft',
      onClick: () => void runTransition('draft', 'Agent set to draft.'),
    },
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={loading}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium capitalize transition-colors disabled:opacity-60 ${statusStyles[agent.status]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change agent status"
      >
        <span className="truncate">{loading ? 'Updating…' : statusLabels[agent.status]}</span>
        <svg className="h-3 w-3 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && menuPos && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="fixed z-[200] min-w-[200px] rounded-xl border border-border bg-card py-1 shadow-lg"
              style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            >
              {menuItems
                .filter((item) => item.show)
                .map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    disabled={loading}
                    onClick={item.onClick}
                    className="flex w-full px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted/50 disabled:opacity-50"
                  >
                    {item.label}
                  </button>
                ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
