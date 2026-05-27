'use client';

import { AgentDetailsView } from '@/components/agents/AgentDetailsView';
import { Breadcrumb } from '@/components/dashboard/ui/Breadcrumb';
import { useLoadedAgent } from '@/components/agents/AgentPageLoader';

export function AgentDetailsPageClient() {
  const agent = useLoadedAgent();

  return (
    <div className="space-y-6">
      <Breadcrumb
        items={[
          { label: 'Agents', href: '/dashboard/agents' },
          { label: agent.name },
        ]}
      />
      <AgentDetailsView agent={agent} />
    </div>
  );
}
