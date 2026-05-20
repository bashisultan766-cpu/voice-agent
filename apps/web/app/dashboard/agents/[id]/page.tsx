import { notFound } from 'next/navigation';
import { getAgentServer } from '@/lib/api/agents-server';
import { ToastProvider } from '@/components/ui/Toast';
import { AgentDetailsView } from '@/components/agents/AgentDetailsView';
import { Breadcrumb } from '@/components/dashboard/ui/Breadcrumb';

export const dynamic = 'force-dynamic';

interface AgentDetailsPageProps {
  params: Promise<{ id: string }>;
}

export default async function AgentDetailsPage({ params }: AgentDetailsPageProps) {
  const { id } = await params;
  const agent = await getAgentServer(id);
  if (!agent) notFound();

  return (
    <ToastProvider>
      <div className="space-y-6">
        <Breadcrumb
          items={[
            { label: 'Agents', href: '/dashboard/agents' },
            { label: agent.name },
          ]}
        />
        <AgentDetailsView agent={agent} />
      </div>
    </ToastProvider>
  );
}
