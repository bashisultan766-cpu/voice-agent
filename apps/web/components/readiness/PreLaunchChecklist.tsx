'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getAgents, type AgentListItem } from '@/lib/api/agents';
import { getAgentReadiness } from '@/lib/api/agents';
import { getShopifyConnectionStatus, getShopifyWebhookHealth, type ShopifyWebhookHealth } from '@/lib/api/shopify';
import { getSystemHealth } from '@/lib/api/system';
import { getTenantIntegrationSummary, type TenantIntegrationSummary } from '@/lib/api/tenant-integrations';

type CheckState = 'pass' | 'warn' | 'fail';

interface AgentReadinessRow {
  agent: AgentListItem;
  shopifyConnected: boolean;
  webhookFreshness?: ShopifyWebhookHealth['freshness'];
  webhookFailures24h?: number;
}

function stateBadge(s: CheckState) {
  if (s === 'pass') return 'bg-emerald-50 text-emerald-700 border border-emerald-100';
  if (s === 'warn') return 'bg-amber-50 text-amber-800 border border-amber-200';
  return 'bg-red-50 text-red-700 border border-red-200';
}

export function PreLaunchChecklist() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [apiHealthy, setApiHealthy] = useState<boolean>(false);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [rows, setRows] = useState<AgentReadinessRow[]>([]);
  const [integrationSummary, setIntegrationSummary] = useState<TenantIntegrationSummary | null>(null);
  const [activeAgentReadiness, setActiveAgentReadiness] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [health, list] = await Promise.all([
          getSystemHealth().catch(() => ({ ok: false })),
          getAgents(),
        ]);
        const summary = await getTenantIntegrationSummary().catch(() => null);
        setApiHealthy(Boolean(health?.ok));
        setAgents(list);
        setIntegrationSummary(summary);

        const detailRows: AgentReadinessRow[] = await Promise.all(
          list.map(async (a) => {
            if (a.shopifyConnectionStatus !== 'ok') {
              return { agent: a, shopifyConnected: false };
            }
            const [conn, wh] = await Promise.all([
              getShopifyConnectionStatus(a.id).catch(() => null),
              getShopifyWebhookHealth(a.id).catch(() => null),
            ]);
            return {
              agent: a,
              shopifyConnected: Boolean(conn?.connected),
              webhookFreshness: wh?.freshness,
              webhookFailures24h: wh?.totalFailures24h ?? 0,
            };
          }),
        );
        setRows(detailRows);
        const active = list.find((a) => a.status === 'active') ?? list[0] ?? null;
        if (active) {
          const readiness = await getAgentReadiness(active.id).catch(() => null);
          const checks = new Map((readiness?.checks ?? []).map((c) => [c.key, c.pass]));
          setActiveAgentReadiness({
            activeAgentSelected: true,
            systemPrompt: checks.get('system_prompt_present') === true,
            shopifyTool: checks.get('catalog_ready') === true,
            paymentLinkTool: checks.get('payment_webhook_configured') === true,
            emailTool: checks.get('email_connected') === true,
            twilioWebhook: checks.get('twilio_webhook_verified') === true,
          });
        } else {
          setActiveAgentReadiness({ activeAgentSelected: false });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load readiness checks.');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const summary = useMemo(() => {
    const hasAgents = agents.length > 0;
    const activeCount = agents.filter((a) => a.status === 'active').length;
    const allConnectionsHealthy = rows.filter((r) => r.agent.status === 'active').every((r) => {
      return (
        r.agent.shopifyConnectionStatus === 'ok' &&
        r.agent.twilioConnectionStatus === 'ok' &&
        r.agent.openaiConnectionStatus === 'ok'
      );
    });
    const anyWebhookStale = rows.some(
      (r) => r.shopifyConnected && (r.webhookFreshness === 'stale' || (r.webhookFailures24h ?? 0) > 0),
    );
    return { hasAgents, activeCount, allConnectionsHealthy, anyWebhookStale };
  }, [agents, rows]);

  const checks: Array<{ label: string; state: CheckState; detail: string }> = [
    {
      label: 'API health',
      state: apiHealthy ? 'pass' : 'fail',
      detail: apiHealthy ? 'Backend health endpoint is reachable.' : 'Backend is not healthy/reachable.',
    },
    {
      label: 'At least one agent configured',
      state: summary.hasAgents ? 'pass' : 'fail',
      detail: summary.hasAgents ? `${agents.length} agent(s) found.` : 'No agents configured yet.',
    },
    {
      label: 'At least one active agent',
      state: summary.activeCount > 0 ? 'pass' : 'warn',
      detail: summary.activeCount > 0 ? `${summary.activeCount} active agent(s).` : 'No active agents yet.',
    },
    {
      label: 'Active agents connection status',
      state: summary.allConnectionsHealthy ? 'pass' : 'warn',
      detail: summary.allConnectionsHealthy
        ? 'Shopify + Twilio + OpenAI look healthy for active agents.'
        : 'Some active agents still have unknown/failed connection status.',
    },
    {
      label: 'Shopify webhook delivery',
      state: summary.anyWebhookStale ? 'warn' : 'pass',
      detail: summary.anyWebhookStale
        ? 'At least one connected store has stale or failing webhooks.'
        : 'Webhook freshness and failure metrics look healthy.',
    },
  ];
  const voiceReadinessItems: Array<[string, boolean]> = [
    ['Twilio saved', integrationSummary?.twilio.configured === true],
    ['Twilio test successful', integrationSummary?.twilio.lastTestOk === true],
    ['Phone number exists', Boolean(integrationSummary?.twilio.phoneNumber)],
    ['Voice webhook configured', activeAgentReadiness.twilioWebhook === true],
    ['Resend saved', integrationSummary?.email.configured === true],
    ['Resend test successful', integrationSummary?.email.lastTestOk === true],
    ['Shopify saved', integrationSummary?.shopify.configured === true],
    ['Shopify test successful', integrationSummary?.shopify.lastTestOk === true],
    ['Active agent selected', activeAgentReadiness.activeAgentSelected === true],
    ['Agent has system prompt', activeAgentReadiness.systemPrompt === true],
    ['Shopify product lookup tool', activeAgentReadiness.shopifyTool === true],
    ['Payment link creation tool', activeAgentReadiness.paymentLinkTool === true],
    ['Email sending tool', activeAgentReadiness.emailTool === true],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-medium tracking-tight text-foreground">Pre-launch checklist</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Run these checks before going live with your Shopify voice agents.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-3 md:grid-cols-2">
        {checks.map((c) => (
          <div key={c.label} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">{c.label}</p>
              <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${stateBadge(c.state)}`}>
                {loading ? 'loading' : c.state}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{c.detail}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-medium text-foreground">Voice agent readiness</h2>
        <p className="mt-1 text-xs text-muted-foreground">Live call prerequisites for current workspace and active agent.</p>
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {voiceReadinessItems.map(([label, pass]) => (
            <div key={label} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span className="text-foreground">{label}</span>
              <span className={pass ? 'text-emerald-700' : 'text-amber-700'}>{pass ? 'Yes' : 'No'}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-medium text-foreground">Agent readiness matrix</h2>
        <p className="mt-1 text-xs text-muted-foreground">Connection and webhook health per agent.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Shopify</th>
                <th className="px-3 py-2">Twilio</th>
                <th className="px-3 py-2">OpenAI</th>
                <th className="px-3 py-2">Webhook freshness</th>
                <th className="px-3 py-2">Webhook failures (24h)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agent.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium text-foreground">{r.agent.name}</td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{r.agent.status}</td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{r.agent.shopifyConnectionStatus}</td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{r.agent.twilioConnectionStatus}</td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{r.agent.openaiConnectionStatus}</td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{r.webhookFreshness ?? 'n/a'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.webhookFailures24h ?? 0}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No agents found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/dashboard/stores"
          className="rounded-lg border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90"
        >
          Manage store connection
        </Link>
        <Link
          href="/dashboard/agents"
          className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          Review agents
        </Link>
      </div>
    </div>
  );
}

