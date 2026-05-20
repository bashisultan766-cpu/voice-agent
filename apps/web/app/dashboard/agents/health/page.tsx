import { AgentHealthClient } from '@/components/dashboard/ops/AgentHealthClient';
import { ToastProvider } from '@/components/ui/Toast';

export const dynamic = 'force-dynamic';

export default function AgentHealthPage() {
  return (
    <ToastProvider>
      <AgentHealthClient />
    </ToastProvider>
  );
}
