'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteAgent } from '@/lib/api/agents';

interface DeleteAgentButtonProps {
  agentId: string;
  agentName: string;
}

export function DeleteAgentButton({ agentId, agentName }: DeleteAgentButtonProps) {
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  const handleClick = async () => {
    if (!confirm(`Delete agent "${agentName}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteAgent(agentId);
      router.refresh();
    } catch {
      setDeleting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={deleting}
      className="text-red-600 hover:underline disabled:opacity-50"
    >
      {deleting ? 'Deleting…' : 'Delete'}
    </button>
  );
}
