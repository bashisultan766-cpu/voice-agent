import { getAgentServer } from '@/lib/api/agents-server';
import { ToastProvider } from '@/components/ui/Toast';
import { AgentDetailsView } from '@/components/agents/AgentDetailsView';
import { AgentPageLoader } from '@/components/agents/AgentPageLoader';
import { Breadcrumb } from '@/components/dashboard/ui/Breadcrumb';

export const dynamic = 'force-dynamic';

interface AgentDetailsPageProps {
  params: Promise<{ id: string }>;
}

export default async function AgentDetailsPage({ params }: AgentDetailsPageProps) {
  const { id } = await params;
  const initialAgent = await getAgentServer(id);

  return (
    <ToastProvider>
      <AgentPageLoader agentId={id} initialAgent={initialAgent}>
        {(agent) => (
          <div className="space-y-6">
            <Breadcrumb
              items={[
                { label: 'Agents', href: '/dashboard/agents' },
                { label: agent.name },
              ]}
            />
            <AgentDetailsView agent={agent} />
          </div>
        )}
      </AgentPageLoader>
    </ToastProvider>
  );
}
