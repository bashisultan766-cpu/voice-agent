import { AgentsDashboard } from '@/components/agents/AgentsDashboard';
import { getAgentsServer } from '@/lib/api/agents-server';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const { items, error } = await getAgentsServer();
  return (
    <AgentsDashboard skipInitialFetch initialAgents={items} initialError={error} />
  );
}
