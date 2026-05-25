'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AgentApi, AgentReadinessResponse, ConnectionStatusApi } from '@/lib/api/agents';
import {
  mapStatus,
  testAgentConnection,
  getAgentAnalytics,
  getAgentLogs,
  getAgentCatalogReadiness,
  testAgentAi,
  simulateAgentBuyingFlow,
  getAgentReadiness,
  getAgentRuntimePromptPreview,
  type RuntimePromptPreview,
  configureTwilioWebhook,
  syncAgentSecretsFromSettings,
  runAgentSmokeTest,
  goLiveAgent,
  sendAgentTestEmail,
} from '@/lib/api/agents';
import { updateAgent, deleteAgent, createAgent, agentToFormData, getAgent } from '@/lib/api/agents';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { PublicAgentLinkShare } from './PublicAgentLinkShare';
import { AgentRuntimeDebugPanel } from './AgentRuntimeDebugPanel';

type TestTarget = 'shopify' | 'twilio' | 'openai' | 'elevenlabs';

interface AgentDetailsViewProps {
  agent: AgentApi;
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  } catch {
    return iso;
  }
}

function connectionLabel(s?: ConnectionStatusApi | null): string {
  if (s === 'OK') return 'Connected';
  if (s === 'FAILED') return 'Failed';
  return 'Not tested';
}

function connectionClass(s?: ConnectionStatusApi | null): string {
  if (s === 'OK') return 'bg-emerald-50 text-emerald-700 border border-emerald-100';
  if (s === 'FAILED') return 'bg-red-50 text-red-600 border border-red-100';
  return 'bg-slate-50 text-slate-500 border border-slate-200';
}

function DetailSection({
  title,
  children,
  description,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2.5 text-sm first:pt-0 last:pb-0 border-b border-border last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground text-right">{value ?? '—'}</span>
    </div>
  );
}

export function AgentDetailsView({ agent }: AgentDetailsViewProps) {
  const router = useRouter();
  const { addToast } = useToast();
  const [status, setStatus] = useState(agent.status);
  const [loading, setLoading] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [runtimePrompt, setRuntimePrompt] = useState<RuntimePromptPreview | null>(null);
  const [runtimePromptLoading, setRuntimePromptLoading] = useState(false);
  type AnalyticsPayload = {
    totalCalls: number;
    resolvedCalls: number;
    escalatedCalls: number;
    avgDurationSeconds: number | null;
    lastCallAt: string | null;
  };
  const [analytics, setAnalytics] = useState<AnalyticsPayload | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [logs, setLogs] = useState<
    Array<{ id: string; fromNumber: string | null; status: string; escalated: boolean; durationSeconds: number | null; createdAt: string }>
  >([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{ catalogReady: boolean; lastSyncedAt: string | null; itemCount: number; reason: string } | null>(null);
  const [readiness, setReadiness] = useState<AgentReadinessResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAnalyticsLoading(true);
    setLogsLoading(true);
    setAnalyticsError(null);
    setLogsError(null);
    void getAgentAnalytics(agent.id)
      .then((data) => {
        if (!cancelled) setAnalytics(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setAnalytics(null);
          setAnalyticsError(e instanceof Error ? e.message : 'Could not load analytics.');
        }
      })
      .finally(() => {
        if (!cancelled) setAnalyticsLoading(false);
      });
    void getAgentLogs(agent.id, 20)
      .then((list) => {
        if (!cancelled) setLogs(list);
      })
      .catch((e) => {
        if (!cancelled) {
          setLogs([]);
          setLogsError(e instanceof Error ? e.message : 'Could not load call activity.');
        }
      })
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });
    void getAgentCatalogReadiness(agent.id)
      .then((v) => {
        if (!cancelled) setCatalog(v);
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      });
    void getAgentReadiness(agent.id)
      .then((r) => {
        if (!cancelled) setReadiness(r);
      })
      .catch(() => {
        if (!cancelled) setReadiness(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const statusMapped = mapStatus(status);

  const handlePause = async () => {
    setLoading('pause');
    try {
      await updateAgent(agent.id, { agentStatus: 'paused' });
      setStatus('PAUSED');
      addToast('success', 'Agent paused.');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to pause.');
    } finally {
      setLoading(null);
    }
  };

  const handleActivate = async () => {
    setLoading('go-live');
    try {
      const result = await goLiveAgent(agent.id);
      if (result.ready) {
        setStatus('ACTIVE');
        addToast('success', 'Agent is LIVE.');
      } else {
        setStatus('PAUSED');
        addToast('error', 'Agent is not ready for LIVE. Review failed checklist items.');
      }
      setReadiness(result.readiness);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to run go-live.');
    } finally {
      setLoading(null);
    }
  };

  const handleConfigureTwilioWebhook = async () => {
    setLoading('configure-twilio');
    try {
      const r = await configureTwilioWebhook(agent.id);
      setReadiness(r);
      addToast('success', 'Twilio webhook configured and re-verified.');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Twilio webhook configuration failed.');
    } finally {
      setLoading(null);
    }
  };

  const handleSyncSecretsFromSettings = async () => {
    setLoading('sync-secrets');
    try {
      const result = await syncAgentSecretsFromSettings(agent.id);
      const updated = Object.entries(result.updatedSecrets ?? {}).filter(([, changed]) => changed).length;
      addToast(
        'success',
        updated > 0
          ? `Synced ${updated} secret${updated === 1 ? '' : 's'} from Settings and re-tested provider status.`
          : 'Sync completed.',
      );
      router.refresh();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Sync from Settings failed.');
    } finally {
      setLoading(null);
    }
  };

  const handleSmokeTest = async () => {
    setLoading('smoke-test');
    try {
      const result = await runAgentSmokeTest(agent.id);
      if (result.ok) addToast('success', 'Smoke test passed.');
      else addToast('error', 'Smoke test found failing checks. Review readiness checklist.');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Smoke test failed.');
    } finally {
      setLoading(null);
    }
  };

  const handleDuplicate = async () => {
    setLoading('duplicate');
    try {
      const full = await getAgent(agent.id);
      if (!full) return;
      const payload = agentToFormData(full);
      const created = await createAgent({
        ...payload,
        agentName: `${payload.agentName} (Copy)`,
        agentStatus: 'draft',
      });
      addToast('success', 'Agent duplicated.');
      router.push(`/dashboard/agents/${(created as { id: string }).id}`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to duplicate.');
    } finally {
      setLoading(null);
    }
  };

  const [testLoading, setTestLoading] = useState<TestTarget | null>(null);
  const [aiSample, setAiSample] = useState('Where is my order?');
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const handleTestConnection = async (target: TestTarget) => {
    setTestLoading(target);
    try {
      const result = await testAgentConnection(agent.id, target);
      if (result.success) {
        addToast('success', result.message || `${target} connection successful.`);
      } else {
        addToast('error', result.message || `${target} connection failed.`);
      }
      router.refresh();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : `${target} test failed.`);
    } finally {
      setTestLoading(null);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteAgent(agent.id);
      addToast('success', 'Agent deleted.');
      router.push('/dashboard/agents');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to delete.');
      setDeleting(false);
    }
  };

  const handleTestAi = async () => {
    setAiLoading(true);
    setAiResult(null);
    try {
      const r = await testAgentAi(agent.id, aiSample.trim() || undefined);
      setAiResult(r.suggestedResponse || r.message || JSON.stringify(r));
      if (!r.success) addToast('error', r.message || 'AI check failed.');
      else addToast('success', 'Sample response generated.');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'AI check failed.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleSimulateBuyingFlow = async () => {
    setLoading('buy-flow');
    try {
      const queryInput = window.prompt('Search query for the flow (optional):', 'demo');
      const emailInput = window.prompt(
        'Customer email for checkout link (optional):',
        'demo.customer@example.com',
      );
      const sendEmailConfirmed = window.confirm(
        'Send payment email as part of this simulation? Click Cancel to only create checkout link.',
      );

      const result = await simulateAgentBuyingFlow(agent.id, {
        query: queryInput?.trim() || undefined,
        customerEmail: emailInput?.trim() || undefined,
        sendEmail: sendEmailConfirmed,
      });

      if (result.ok) {
        addToast(
          'success',
          sendEmailConfirmed
            ? 'Buying flow completed (checkout + email).'
            : 'Buying flow completed (checkout created).',
        );
      } else {
        addToast('error', `Flow did not complete: ${result.reason || 'unknown error'}`);
      }
      router.refresh();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Buying flow simulation failed.');
    } finally {
      setLoading(null);
    }
  };

  const handleConnectShopifyOAuth = () => {
    const current = (agent.shopifyStoreUrl as string) || '';
    const suggested = current ? current.replace(/^https?:\/\//, '') : '';
    const shop = window.prompt('Enter Shopify domain (e.g. your-store.myshopify.com)', suggested);
    if (!shop?.trim()) return;
    const url = `/api/integrations/shopify/oauth/start?agentId=${encodeURIComponent(agent.id)}&shop=${encodeURIComponent(shop.trim())}`;
    window.location.href = url;
  };

  const handleLoadRuntimePrompt = async () => {
    setRuntimePromptLoading(true);
    try {
      const preview = await getAgentRuntimePromptPreview(agent.id);
      setRuntimePrompt(preview);
      addToast('success', `Runtime prompt loaded (${preview.promptLength} chars).`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to load runtime prompt.');
    } finally {
      setRuntimePromptLoading(false);
    }
  };

  const storedPrompt = (agent.customSystemPrompt as string) || (agent.baseSystemPrompt as string) || '';
  const promptPreview = storedPrompt.length > 400 ? storedPrompt.slice(0, 400) + '…' : storedPrompt;
  const runtimeDisplay =
    runtimePrompt?.prompt ??
    (storedPrompt || 'No system prompt set. Load runtime preview to see the full call prompt.');

  const statusBadgeClass =
    statusMapped === 'active'
      ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
      : statusMapped === 'paused'
        ? 'bg-slate-50 text-slate-500 border border-slate-200'
        : 'bg-slate-50 text-slate-600 border border-slate-200';

  return (
    <div className="space-y-10">
      {/* Overview + Actions */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-xl font-medium tracking-tight text-foreground">{agent.name}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {agent.storeName ?? '—'} · Updated {formatDate(agent.updatedAt)}
          </p>
          <div className="mt-3">
            <span className={`inline-flex rounded-md px-2.5 py-0.5 text-xs font-medium capitalize ${statusBadgeClass}`}>
              {statusMapped}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/dashboard/agents/${agent.id}/edit`}
            className="inline-flex items-center rounded-lg border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:ring-offset-2"
          >
            Edit agent
          </Link>
          {statusMapped !== 'paused' && (
            <button
              type="button"
              onClick={handlePause}
              disabled={!!loading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {loading === 'pause' ? 'Updating…' : 'Pause'}
            </button>
          )}
          {statusMapped !== 'active' && (
            <button
              type="button"
              onClick={handleActivate}
              disabled={!!loading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {loading === 'go-live' ? 'Running checks…' : 'Go Live'}
            </button>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleConnectShopifyOAuth}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              Connect Shopify OAuth
            </button>
            <button
              type="button"
              onClick={handleConfigureTwilioWebhook}
              disabled={!!loading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {loading === 'configure-twilio' ? 'Configuring…' : 'Configure Twilio Webhook'}
            </button>
            <button
              type="button"
              onClick={handleSyncSecretsFromSettings}
              disabled={!!loading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {loading === 'sync-secrets' ? 'Syncing…' : 'Sync secrets from Settings'}
            </button>
            <button
              type="button"
              onClick={handleSmokeTest}
              disabled={!!loading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {loading === 'smoke-test' ? 'Running…' : 'Run Live Call Smoke Test'}
            </button>
            <button
              type="button"
              onClick={handleSimulateBuyingFlow}
              disabled={!!loading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {loading === 'buy-flow' ? 'Running flow…' : 'Simulate buying flow'}
            </button>
            <button
              type="button"
              onClick={() => handleTestConnection('shopify')}
              disabled={!!testLoading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {testLoading === 'shopify' ? 'Testing…' : 'Test Shopify'}
            </button>
            <button
              type="button"
              onClick={() => handleTestConnection('twilio')}
              disabled={!!testLoading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {testLoading === 'twilio' ? 'Testing…' : 'Test Twilio'}
            </button>
            <button
              type="button"
              onClick={() => handleTestConnection('openai')}
              disabled={!!testLoading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {testLoading === 'openai' ? 'Testing…' : 'Test OpenAI'}
            </button>
            <button
              type="button"
              onClick={() => handleTestConnection('elevenlabs')}
              disabled={!!testLoading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
            >
              {testLoading === 'elevenlabs' ? 'Testing…' : 'Test ElevenLabs'}
            </button>
          </div>
          <button
            type="button"
            onClick={handleDuplicate}
            disabled={!!loading}
            className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
          >
            {loading === 'duplicate' ? 'Duplicating…' : 'Duplicate'}
          </button>
          <button
            type="button"
            onClick={() => setDeleteConfirm(true)}
            className="inline-flex items-center rounded-lg border border-red-200 bg-red-50/50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-200 focus:ring-offset-2"
          >
            Delete
          </button>
        </div>
      </div>

      <PublicAgentLinkShare agentId={agent.id} />

      <DetailSection title="Live readiness checklist" description="LIVE is blocked until every required item passes">
        {readiness?.credentialSources ? (
          <div className="mb-4 rounded-lg border bg-muted/20 p-3 text-sm">
            <p className="font-medium text-foreground">Credential sources</p>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              <li>
                Shopify: {readiness.credentialSources.shopify.source}
                {readiness.credentialSources.shopify.configured ? ' (ready)' : ' (not ready)'}
              </li>
              <li>OpenAI: {readiness.credentialSources.openai.source}</li>
              <li>ElevenLabs: {readiness.credentialSources.elevenlabs.source}</li>
              <li>Twilio: {readiness.credentialSources.twilio.authSource}</li>
              <li>Resend: {readiness.credentialSources.resend.source}</li>
            </ul>
          </div>
        ) : null}
        <div className="space-y-0 divide-y divide-border">
          {(readiness?.checks ?? []).map((item) => (
            <DetailRow
              key={item.key}
              label={item.label}
              value={
                <span className={item.pass ? 'text-emerald-700' : 'text-red-700'}>
                  {item.pass ? 'PASS' : `FAIL - ${item.fixAction}`}
                </span>
              }
            />
          ))}
          <DetailRow label="Required inbound webhook URL" value={readiness?.expectedTwilioWebhookUrls.inbound ?? '—'} />
          <DetailRow label="Required status callback URL" value={readiness?.expectedTwilioWebhookUrls.status ?? '—'} />
          <DetailRow label="Required webhook method" value={readiness?.expectedTwilioWebhookUrls.method ?? 'POST'} />
        </div>
      </DetailSection>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Basic information */}
        <DetailSection title="Basic information" description="Name, store, and locale">
          <div className="space-y-0 divide-y divide-border">
            <DetailRow label="Agent name" value={agent.name} />
            <DetailRow label="Store name" value={agent.storeName as string} />
            <DetailRow label="Store URL" value={(agent.storeUrl as string) || '—'} />
            <DetailRow label="Store email" value={(agent.storeEmail as string) || '—'} />
            <DetailRow label="Language" value={agent.language} />
            <DetailRow label="Timezone" value={(agent.timezone as string) || '—'} />
            <DetailRow label="Created" value={formatDate(agent.createdAt)} />
            <DetailRow label="Last updated" value={formatDate(agent.updatedAt)} />
          </div>
        </DetailSection>

        {/* Voice settings */}
        <DetailSection title="Voice settings" description="Provider and messages">
          <div className="space-y-0 divide-y divide-border">
            <DetailRow label="Voice provider" value={(agent.voiceProvider as string) || '—'} />
            <DetailRow label="ElevenLabs voice ID" value={(agent.voiceId as string) || '—'} />
            <DetailRow label="Voice label" value={(agent.voiceNameLabel as string) || '—'} />
            <DetailRow label="Style" value={(agent.voiceStyle as string) || '—'} />
            <DetailRow
              label="Greeting"
              value={
                (agent.greetingMessage as string)
                  ? `${(agent.greetingMessage as string).slice(0, 60)}${(agent.greetingMessage as string).length > 60 ? '…' : ''}`
                  : '—'
              }
            />
            <DetailRow
              label="Fallback message"
              value={
                (agent.fallbackMessage as string)
                  ? `${(agent.fallbackMessage as string).slice(0, 60)}${(agent.fallbackMessage as string).length > 60 ? '…' : ''}`
                  : '—'
              }
            />
          </div>
        </DetailSection>

        {/* Shopify connection summary */}
        <DetailSection title="Shopify connection" description="Store connection (credentials are stored securely)">
          <div className="space-y-0 divide-y divide-border">
            <DetailRow label="Store URL" value={(agent.shopifyStoreUrl as string) || '—'} />
            <DetailRow
              label="Shopify credential source"
              value={(agent.shopifySource as string) || '—'}
            />
            <DetailRow
              label="Use workspace Shopify"
              value={agent.useWorkspaceShopify === true ? 'Yes' : 'No'}
            />
            <DetailRow label="Credentials" value="••••••••" />
            <DetailRow
              label="Status"
              value={
                <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionClass(agent.shopifyConnectionStatus)}`}>
                  {connectionLabel(agent.shopifyConnectionStatus)}
                </span>
              }
            />
            <DetailRow
              label="Catalog readiness"
              value={catalog ? (catalog.catalogReady ? 'Ready' : 'Not ready') : 'Unknown'}
            />
            <DetailRow label="Catalog item count" value={catalog ? catalog.itemCount : '—'} />
            <DetailRow
              label="Catalog last synced"
              value={catalog?.lastSyncedAt ? formatDate(catalog.lastSyncedAt) : '—'}
            />
          </div>
        </DetailSection>

        {/* Knowledge base summary */}
        <DetailSection
          title="Knowledge base"
          description="Optional FAQs and docs for accurate answers (no database credentials required from you)."
        >
          <div className="space-y-0 divide-y divide-border">
            <DetailRow label="Knowledge source" value={(agent.knowledgeBaseSource as string) || '—'} />
            <DetailRow label="Sync enabled" value={agent.knowledgeSyncEnabled ? 'Yes' : 'No'} />
            <DetailRow
              label="Knowledge sync health"
              value={
                <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionClass(agent.databaseConnectionStatus)}`}>
                  {connectionLabel(agent.databaseConnectionStatus)}
                </span>
              }
            />
          </div>
        </DetailSection>

        {/* Twilio setup summary */}
        <DetailSection title="Twilio setup" description="Phone and call handling (credentials are stored securely)">
          <div className="space-y-0 divide-y divide-border">
            <DetailRow label="Phone number" value={(agent.twilioPhoneNumber as string) || '—'} />
            <DetailRow label="Credentials" value="••••••••" />
            <DetailRow label="Call routing" value={(agent.callRoutingMode as string) || '—'} />
            <DetailRow label="Incoming handling" value={(agent.incomingCallHandling as string) || '—'} />
            <DetailRow
              label="Status"
              value={
                <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionClass(agent.twilioConnectionStatus)}`}>
                  {connectionLabel(agent.twilioConnectionStatus)}
                </span>
              }
            />
          </div>
        </DetailSection>

        {/* Connection health */}
        <DetailSection title="Connection health" description="Last test results">
          <div className="space-y-0 divide-y divide-border">
            <DetailRow
              label="Shopify"
              value={
                <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionClass(agent.shopifyConnectionStatus)}`}>
                  {connectionLabel(agent.shopifyConnectionStatus)}
                </span>
              }
            />
            <DetailRow
              label="Knowledge base"
              value={
                <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionClass(agent.databaseConnectionStatus)}`}>
                  {connectionLabel(agent.databaseConnectionStatus)}
                </span>
              }
            />
            <DetailRow
              label="Twilio"
              value={
                <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionClass(agent.twilioConnectionStatus)}`}>
                  {connectionLabel(agent.twilioConnectionStatus)}
                </span>
              }
            />
            <DetailRow
              label="OpenAI"
              value={
                <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionClass(agent.openaiConnectionStatus)}`}>
                  {connectionLabel(agent.openaiConnectionStatus)}
                </span>
              }
            />
            <DetailRow
              label="ElevenLabs"
              value={
                <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${connectionClass(agent.elevenlabsConnectionStatus)}`}>
                  {connectionLabel(agent.elevenlabsConnectionStatus)}
                </span>
              }
            />
            <DetailRow
              label="Last tested"
              value={agent.lastConnectionTestAt ? formatDate(agent.lastConnectionTestAt as string) : 'Never'}
            />
          </div>
        </DetailSection>
      </div>

      {/* AI behavior & system prompt preview */}
      <DetailSection
        title="AI behavior & runtime prompt"
        description="Stored instructions and the exact prompt used on live calls"
      >
        <div className="space-y-3">
          {((agent.agentRole as string) || (agent.toneOfVoice as string) || (agent.model as string)) && (
            <div className="space-y-0 divide-y divide-border">
              {(agent.agentRole as string) && <DetailRow label="Role" value={agent.agentRole as string} />}
              {(agent.toneOfVoice as string) && <DetailRow label="Tone" value={agent.toneOfVoice as string} />}
              {(agent.model as string) && <DetailRow label="OpenAI model" value={agent.model as string} />}
            </div>
          )}
          {(agent.greetingMessage as string) && (
            <DetailRow label="Greeting" value={agent.greetingMessage as string} />
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleLoadRuntimePrompt}
              disabled={runtimePromptLoading}
              className="inline-flex items-center rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              {runtimePromptLoading ? 'Loading…' : 'Load runtime prompt preview'}
            </button>
            {runtimePrompt && (
              <span className="text-xs text-muted-foreground self-center">
                Prompt version {formatDate(runtimePrompt.updatedAt)} · {runtimePrompt.promptLength} chars
              </span>
            )}
          </div>
          {!runtimePrompt && storedPrompt && (
            <p className="text-xs text-muted-foreground">Stored prompt (truncated): {promptPreview}</p>
          )}
          <div className="rounded-xl border border-border bg-muted/20 p-5 max-h-[420px] overflow-y-auto">
            <pre className="whitespace-pre-wrap text-sm text-foreground font-sans">{runtimeDisplay}</pre>
          </div>
        </div>
      </DetailSection>

      <DetailSection title="Runtime debug" description="Tools, orchestration trace, and live prompt preview">
        <AgentRuntimeDebugPanel agentId={agent.id} />
      </DetailSection>

      <DetailSection title="Email & payment links" description="Resend sender for checkout emails (API keys are never shown)">
        <div className="space-y-0 divide-y divide-border">
          <DetailRow label="Sender name" value={(agent.emailSenderName as string) || '—'} />
          <DetailRow label="Sender email" value={(agent.emailSenderAddress as string) || '—'} />
          <DetailRow label="Reply-to" value={(agent.emailReplyTo as string) || '—'} />
          <DetailRow label="Subject template" value={(agent.emailSubjectTemplate as string) || '—'} />
          <DetailRow
            label="Resend key"
            value={(agent.resendApiKeyConfigured as boolean) ? 'Configured (encrypted)' : 'Not set on agent'}
          />
          <DetailRow label="Use workspace email" value={agent.useWorkspaceEmail !== false ? 'Yes' : 'No'} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={async () => {
              try {
                const result = await sendAgentTestEmail(agent.id, {
                  toEmail: (agent.emailTestRecipient as string) || undefined,
                });
                if (result.success) addToast('success', result.message);
                else addToast('error', result.message);
              } catch (e) {
                addToast('error', e instanceof Error ? e.message : 'Test email failed.');
              }
            }}
            className="inline-flex items-center rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Send test email
          </button>
        </div>
      </DetailSection>

      {/* Customer handling rules */}
      <DetailSection title="Customer handling rules" description="Returns, orders, escalation">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-0 divide-y divide-border">
            <DetailRow label="Return / refund" value={(agent.returnRefundBehavior as string) ? 'Set' : '—'} />
            <DetailRow label="Order status" value={(agent.orderStatusHandling as string) ? 'Set' : '—'} />
            <DetailRow label="Out of stock" value={(agent.outOfStockHandling as string) ? 'Set' : '—'} />
          </div>
          <div className="space-y-0 divide-y divide-border">
            <DetailRow label="Transfer to human" value={agent.transferToHumanEnabled ? 'Yes' : 'No'} />
            <DetailRow label="Escalation phone" value={(agent.escalationPhone as string) || '—'} />
            <DetailRow label="Escalation email" value={(agent.escalationEmail as string) || '—'} />
          </div>
        </div>
      </DetailSection>

      {/* Agent performance / analytics */}
      <DetailSection title="Agent performance" description="Call volume and resolution (from call sessions)">
        {analyticsLoading ? (
          <p className="text-sm text-muted-foreground">Loading metrics…</p>
        ) : analyticsError ? (
          <p className="text-sm text-red-700 dark:text-red-300">{analyticsError}</p>
        ) : analytics ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Total calls</p>
                <p className="mt-1 text-2xl font-semibold text-foreground">{analytics.totalCalls}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Resolved</p>
                <p className="mt-1 text-2xl font-semibold text-foreground">{analytics.resolvedCalls}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Escalated</p>
                <p className="mt-1 text-2xl font-semibold text-foreground">{analytics.escalatedCalls}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Avg duration</p>
                <p className="mt-1 text-2xl font-semibold text-foreground">
                  {analytics.avgDurationSeconds != null ? `${analytics.avgDurationSeconds}s` : '—'}
                </p>
              </div>
            </div>
            {analytics.lastCallAt ? (
              <p className="mt-2 text-xs text-muted-foreground">Last call: {formatDate(analytics.lastCallAt)}</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No call data yet. Metrics will appear once the agent handles calls.</p>
        )}
      </DetailSection>

      {/* Recent call activity / logs */}
      <DetailSection
        title="Recent call activity"
        description="Latest call sessions for this agent. Open the calls hub for the full tenant log."
      >
        <div className="mb-4">
          <Link
            href="/dashboard/calls"
            className="text-sm font-medium text-violet-600 hover:underline dark:text-violet-400"
          >
            View all call logs →
          </Link>
        </div>
        {logsLoading ? (
          <p className="text-sm text-muted-foreground">Loading recent calls…</p>
        ) : logsError ? (
          <p className="text-sm text-red-700 dark:text-red-300">{logsError}</p>
        ) : logs.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">From</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Escalated</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Duration</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground"> </th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-t border-border">
                    <td className="px-4 py-2 text-foreground">{log.fromNumber || '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground capitalize">{log.status.toLowerCase()}</td>
                    <td className="px-4 py-2">{log.escalated ? 'Yes' : 'No'}</td>
                    <td className="px-4 py-2">{log.durationSeconds != null ? `${log.durationSeconds}s` : '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{formatDate(log.createdAt)}</td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/dashboard/transcripts/${log.id}`}
                        className="text-sm font-medium text-violet-600 hover:underline dark:text-violet-400"
                      >
                        Transcript
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No call sessions yet. Logs will appear when customers call.</p>
        )}
      </DetailSection>

      <ConfirmDeleteModal
        agentName={agent.name}
        open={deleteConfirm}
        onClose={() => setDeleteConfirm(false)}
        onConfirm={handleConfirmDelete}
        loading={deleting}
      />
    </div>
  );
}
