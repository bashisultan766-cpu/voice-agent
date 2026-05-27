import { ToastProvider } from '@/components/ui/Toast';
import { getAgentServer } from '@/lib/api/agents-server';
import { AgentPageLoader } from '@/components/agents/AgentPageLoader';
import { normalizeAgentForClient } from '@/lib/agents/normalize-agent-for-client';
import { AgentEditPageClient } from '@/components/agents/AgentEditPageClient';

export const dynamic = 'force-dynamic';

interface AgentEditPageProps {
  params: Promise<{ id: string }>;
}

export default async function AgentEditPage({ params }: AgentEditPageProps) {
  const { id } = await params;
  const initialAgent = normalizeAgentForClient(await getAgentServer(id));

  return (
    <ToastProvider>
      <AgentPageLoader agentId={id} initialAgent={initialAgent}>
        <AgentEditPageClient agentId={id} />
      </AgentPageLoader>
    </ToastProvider>
  );
}
