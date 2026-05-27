import { AgentsDashboard } from '@/components/agents/AgentsDashboard';
import { ToastProvider } from '@/components/ui/Toast';
import { getAgentsServer } from '@/lib/api/agents-server';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const { items, error } = await getAgentsServer();
  return (
    <ToastProvider>
      <AgentsDashboard skipInitialFetch initialAgents={items} initialError={error} />
    </ToastProvider>
  );
}
