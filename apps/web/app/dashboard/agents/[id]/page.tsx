import { getAgentServer } from '@/lib/api/agents-server';
import { ToastProvider } from '@/components/ui/Toast';
import { AgentPageLoader } from '@/components/agents/AgentPageLoader';
import { normalizeAgentForClient } from '@/lib/agents/normalize-agent-for-client';
import { AgentDetailsPageClient } from '@/components/agents/AgentDetailsPageClient';

export const dynamic = 'force-dynamic';

interface AgentDetailsPageProps {
  params: Promise<{ id: string }>;
}

export default async function AgentDetailsPage({ params }: AgentDetailsPageProps) {
  const { id } = await params;
  const initialAgent = normalizeAgentForClient(await getAgentServer(id));

  return (
    <ToastProvider>
      <AgentPageLoader agentId={id} initialAgent={initialAgent}>
        <AgentDetailsPageClient />
      </AgentPageLoader>
    </ToastProvider>
  );
}
