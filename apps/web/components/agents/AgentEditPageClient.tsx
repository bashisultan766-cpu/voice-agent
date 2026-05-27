'use client';

import Link from 'next/link';
import { CreateAgentForm } from '@/components/agents/CreateAgentForm';
import type { CreateAgentFormData } from '@/components/agents/form-types';
import { Breadcrumb } from '@/components/dashboard/ui/Breadcrumb';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { agentToFormData, mapStatus, type CredentialSourcesSummaryApi } from '@/lib/api/agents';
import { useAgentPageLoader } from '@/components/agents/AgentPageLoader';

export function AgentEditPageClient({ agentId }: { agentId: string }) {
  const { agent, reloadAgent } = useAgentPageLoader();
  const initialData = agentToFormData(agent);
  const sources = agent.credentialSources as CredentialSourcesSummaryApi | undefined;
  const conn = (status: string | undefined, configured?: boolean) => {
    if (configured === true || status === 'OK') return 'ok' as const;
    if (status === 'FAILED') return 'failed' as const;
    return 'unknown' as const;
  };
  const savedCredentials = {
    shopify: conn(agent.shopifyConnectionStatus as string | undefined, sources?.shopify.configured),
    twilio: conn(agent.twilioConnectionStatus as string | undefined, sources?.twilio.configured),
    openai: conn(agent.openaiConnectionStatus as string | undefined, sources?.openai.configured),
    elevenlabs: conn(
      agent.elevenlabsConnectionStatus as string | undefined,
      sources?.elevenlabs.configured,
    ),
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
        key={`${agentId}-${agent.updatedAt}`}
        agentId={agentId}
        initialData={initialData as CreateAgentFormData}
        savedCredentials={savedCredentials}
        lastTestedAt={agent.lastConnectionTestAt ?? null}
        onAgentSaved={async () => {
          await reloadAgent();
        }}
      />
    </div>
  );
}
