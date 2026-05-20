import Link from 'next/link';
import { CreateAgentForm } from '@/components/agents/CreateAgentForm';
import { ToastProvider } from '@/components/ui/Toast';
import { createShopifyVoiceAgentAction, testShopifyConnectionAction } from './actions';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { Breadcrumb } from '@/components/dashboard/ui/Breadcrumb';

export default function CreateAgentPage() {
  return (
    <ToastProvider>
      <div className="space-y-8">
        <Breadcrumb items={[{ label: 'Agents', href: '/dashboard/agents' }, { label: 'Create' }]} />
        <PageHeader
          eyebrow="Shopify voice agent"
          title="Create agent"
          description="Work through each step, then on the final review use Create agent or Save as draft in the bar at the bottom. You can jump between steps anytime."
          actions={
            <Link
              href="/dashboard/agents"
              className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium shadow-sm hover:bg-muted"
            >
              Cancel
            </Link>
          }
        />

        <CreateAgentForm
          createAgentAction={createShopifyVoiceAgentAction}
          testShopifyAction={testShopifyConnectionAction}
        />
      </div>
    </ToastProvider>
  );
}
