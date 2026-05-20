'use client';

import { useEffect, useMemo, useState } from 'react';
import { getAgents, type AgentListItem } from '@/lib/api/agents';
import {
  disconnectShopify,
  getShopifyConnectionStatus,
  getShopifyWebhookHealth,
  getShopifyOauthStartUrl,
  type ShopifyConnectionStatus,
  type ShopifyWebhookHealth,
  type ShopifyWebhookTopic,
} from '@/lib/api/shopify';

function badge(status: 'connected' | 'disconnected' | 'failed') {
  if (status === 'connected') return 'bg-emerald-50 text-emerald-700 border border-emerald-100';
  if (status === 'failed') return 'bg-red-50 text-red-600 border border-red-100';
  return 'bg-slate-50 text-slate-500 border border-slate-200';
}

export function StoreConnectionDashboard() {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [shopDomainInput, setShopDomainInput] = useState<string>('');
  const [status, setStatus] = useState<ShopifyConnectionStatus | null>(null);
  const [health, setHealth] = useState<ShopifyWebhookHealth | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    async function load() {
      setLoadingAgents(true);
      setError('');
      try {
        const list = await getAgents();
        setAgents(list);
        if (list.length > 0) setSelectedAgentId((prev) => prev || list[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load agents.');
      } finally {
        setLoadingAgents(false);
      }
    }
    void load();
  }, []);

  useEffect(() => {
    async function loadStatus() {
      if (!selectedAgentId) {
        setStatus(null);
        return;
      }
      setLoadingStatus(true);
      setError('');
      try {
        const s = await getShopifyConnectionStatus(selectedAgentId);
        setStatus(s);
        if (s.shopDomain) setShopDomainInput(s.shopDomain);
      } catch (e) {
        setStatus(null);
        setError(e instanceof Error ? e.message : 'Failed to load Shopify status.');
      } finally {
        setLoadingStatus(false);
      }
    }
    void loadStatus();
  }, [selectedAgentId]);

  useEffect(() => {
    async function loadHealth() {
      if (!selectedAgentId) {
        setHealth(null);
        return;
      }
      setLoadingHealth(true);
      setError('');
      try {
        const h = await getShopifyWebhookHealth(selectedAgentId);
        setHealth(h);
      } catch (e) {
        setHealth(null);
        setError(e instanceof Error ? e.message : 'Failed to load webhook health.');
      } finally {
        setLoadingHealth(false);
      }
    }
    void loadHealth();
  }, [selectedAgentId]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const statusLabel =
    status?.connected
      ? 'connected'
      : status?.status === 'FAILED'
        ? 'failed'
        : 'disconnected';

  const onConnect = () => {
    if (!selectedAgentId) return;
    const shop = shopDomainInput.trim();
    if (!shop) {
      setError('Enter your Shopify domain (e.g. your-store.myshopify.com).');
      return;
    }
    window.location.href = getShopifyOauthStartUrl(selectedAgentId, shop);
  };

  const onDisconnect = async () => {
    if (!selectedAgentId) return;
    if (!confirm('Disconnect Shopify for this agent?')) return;
    setBusy(true);
    setError('');
    try {
      await disconnectShopify(selectedAgentId);
      const refreshed = await getShopifyConnectionStatus(selectedAgentId);
      setStatus(refreshed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect Shopify.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-medium tracking-tight text-foreground">Connect Store</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect, reconnect, and disconnect Shopify for each voice agent.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Select agent</span>
            <select
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm"
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              disabled={loadingAgents || agents.length === 0}
            >
              {agents.length === 0 ? (
                <option value="">{loadingAgents ? 'Loading agents…' : 'No agents found'}</option>
              ) : (
                agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Shopify domain</span>
            <input
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm"
              value={shopDomainInput}
              onChange={(e) => setShopDomainInput(e.target.value)}
              placeholder="your-store.myshopify.com"
            />
          </label>
        </div>

        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Connection status</span>
            <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${badge(statusLabel)}`}>
              {loadingStatus ? 'Loading…' : statusLabel}
            </span>
          </div>
          <div className="mt-2 text-muted-foreground">
            {status?.shopDomain ? `Shop: ${status.shopDomain}` : 'No store connected yet.'}
          </div>
          {status?.webhookTopics && status.webhookTopics.length > 0 && (
            <div className="mt-2 text-xs text-muted-foreground">
              Webhooks: {status.webhookTopics.join(', ')}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-muted/10 px-4 py-3 text-sm space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Webhook health</span>
            <span
              className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${
                health?.freshness === 'fresh'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                  : health?.freshness === 'ok'
                    ? 'bg-amber-50 text-amber-800 border border-amber-200'
                    : health?.freshness === 'stale'
                      ? 'bg-red-50 text-red-600 border border-red-100'
                      : 'bg-slate-50 text-slate-500 border border-slate-200'
              }`}
            >
              {loadingHealth ? 'Loading…' : health?.freshness ?? 'disconnected'}
            </span>
          </div>

          {health?.lastSyncedAt ? (
            <div className="text-xs text-muted-foreground">
              Last sync: {new Date(health.lastSyncedAt).toLocaleString()}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">Last sync: never</div>
          )}
          <div className="text-xs text-muted-foreground">
            Failures (24h): {health?.totalFailures24h ?? 0}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {([
              { topic: 'orders/create' as ShopifyWebhookTopic, label: 'Orders (create)' },
              { topic: 'carts/create' as ShopifyWebhookTopic, label: 'Carts (create)' },
              { topic: 'orders/updated' as ShopifyWebhookTopic, label: 'Orders (updated)' },
              { topic: 'products/create' as ShopifyWebhookTopic, label: 'Products (create)' },
              { topic: 'products/update' as ShopifyWebhookTopic, label: 'Products (update)' },
              { topic: 'customers/create' as ShopifyWebhookTopic, label: 'Customers (create)' },
              { topic: 'customers/update' as ShopifyWebhookTopic, label: 'Customers (update)' },
            ] as const).map(({ topic, label }) => {
              const last = health?.lastReceivedAtByTopic?.[topic] ?? null;
              const lastFail = health?.lastFailureAtByTopic?.[topic] ?? null;
              const failCount = health?.failureCount24hByTopic?.[topic] ?? 0;
              const has = typeof last === 'string' && last.length > 0;
              return (
                <div key={topic} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <span className="text-right text-xs">
                    <span className={`block font-medium ${has ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                      {has ? `OK: ${new Date(last!).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'OK: —'}
                    </span>
                    <span className={`${failCount > 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                      {`Fail: ${failCount}${lastFail ? ` (last ${new Date(lastFail).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })})` : ''}`}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onConnect}
            disabled={!selectedAgent || busy}
            className="rounded-lg border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {status?.connected ? 'Reconnect with OAuth' : 'Connect with OAuth'}
          </button>
          <button
            type="button"
            onClick={onDisconnect}
            disabled={!status?.connected || busy}
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}

