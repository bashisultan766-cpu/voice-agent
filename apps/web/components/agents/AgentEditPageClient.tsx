'use client';

import Link from 'next/link';
import { CreateAgentForm } from '@/components/agents/CreateAgentForm';
import type { CreateAgentFormData } from '@/components/agents/form-types';
import { Breadcrumb } from '@/components/dashboard/ui/Breadcrumb';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { agentToFormData, mapStatus } from '@/lib/api/agents';
import { useLoadedAgent } from '@/components/agents/AgentPageLoader';

export function AgentEditPageClient({ agentId }: { agentId: string }) {
  const agent = useLoadedAgent();
  const initialData = agentToFormData(agent);
  const savedCredentials = {
    shopify:
      agent.shopifyConnectionStatus === 'OK'
        ? ('ok' as const)
        : agent.shopifyConnectionStatus === 'FAILED'
          ? ('failed' as const)
          : ('unknown' as const),
    twilio:
      agent.twilioConnectionStatus === 'OK'
        ? ('ok' as const)
        : agent.twilioConnectionStatus === 'FAILED'
          ? ('failed' as const)
          : ('unknown' as const),
    openai:
      agent.openaiConnectionStatus === 'OK'
        ? ('ok' as const)
        : agent.openaiConnectionStatus === 'FAILED'
          ? ('failed' as const)
          : ('unknown' as const),
    elevenlabs:
      agent.elevenlabsConnectionStatus === 'OK'
        ? ('ok' as const)
        : agent.elevenlabsConnectionStatus === 'FAILED'
          ? ('failed' as const)
          : ('unknown' as const),
  };

  const statusLabel = mapStatus(agent.status);

  return (
    <div className="space-y-8">
      <Breadcrumb
        items={[
          { label: 'Agents', href: '/dashboard/agents' },
          { label: agent.name, href: `/dashboard/agents/${agentId}` },
          { label: 'Edit' },
        ]}
      />
      <PageHeader
        eyebrow="Shopify voice agent"
        title={`Edit · ${agent.name}`}
        description="Changes apply when you save. Credential fields stay empty on purpose—leave them blank to keep stored secrets. Use “Save & go to details” when you want to leave this page."
        actions={
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium capitalize ${
                statusLabel === 'active'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300'
                  : statusLabel === 'paused'
                    ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200'
                    : 'border-border bg-muted/50 text-muted-foreground'
              }`}
            >
              {statusLabel}
            </span>
            <Link
              href={`/dashboard/agents/${agentId}`}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-muted"
            >
              Details
            </Link>
          </div>
        }
      />

      <CreateAgentForm
        key={agentId}
        agentId={agentId}
        initialData={initialData as CreateAgentFormData}
        savedCredentials={savedCredentials}
        lastTestedAt={agent.lastConnectionTestAt ?? null}
      />
    </div>
  );
}
