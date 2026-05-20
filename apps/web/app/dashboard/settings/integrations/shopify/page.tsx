'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  formatIntegrationLastTested,
  getTenantIntegrationSummary,
  looksLikeMaskedSecretOnly,
  normalizeShopifyIntegrationDomainInput,
  parseIntegrationTestJson,
  tenantIntegrationHeaders,
} from '@/lib/api/tenant-integrations';
import { parseApiErrorMessage } from '@/lib/api/error-message';

export default function ShopifyIntegrationSettingsPage() {
  const loadGen = useRef(0);
  const [shopDomain, setShopDomain] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [tokenMasked, setTokenMasked] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const [lastTestAt, setLastTestAt] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<'success' | 'error' | 'neutral' | 'warning'>('neutral');

  useEffect(() => {
    const id = ++loadGen.current;
    setSummaryLoading(true);
    setSummaryError(null);
    void getTenantIntegrationSummary()
      .then((s) => {
        if (id !== loadGen.current) return;
        setConnected(s.shopify.configured);
        setLastOk(s.shopify.lastTestOk);
        setLastTestAt(s.shopify.lastTestAt);
        setTokenMasked(s.shopify.tokenMasked);
        setShopDomain((prev) => (prev.trim() !== '' ? prev : s.shopify.shopDomain || ''));
      })
      .catch((e) => {
        if (id !== loadGen.current) return;
        setSummaryError(e instanceof Error ? e.message : 'Could not load integration status. Is the API running?');
      })
      .finally(() => {
        if (id !== loadGen.current) return;
        setSummaryLoading(false);
      });
  }, []);

  function setFeedback(tone: typeof msgTone, text: string) {
    setMsgTone(tone);
    setMsg(text);
  }

  /** Never put masked hints in the input; omit empty / bogus token so backend can use saved secret. */
  function shopifyRequestBody(): { shopDomain: string; accessToken?: string } {
    const host = normalizeShopifyIntegrationDomainInput(shopDomain);
    const t = accessToken.trim();
    if (t && !looksLikeMaskedSecretOnly(t)) {
      return { shopDomain: host, accessToken: t };
    }
    return { shopDomain: host };
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const body = shopifyRequestBody();
      if (!body.shopDomain) {
        setFeedback('error', 'Enter your myshopify.com shop domain.');
        return;
      }
      if (!body.accessToken && !connected) {
        setFeedback('error', 'Enter a new access token to test, or save credentials first.');
        return;
      }

      const res = await fetch('/api/tenant-integrations/shopify/test', {
        method: 'POST',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        setFeedback('error', parseApiErrorMessage(text, res.status));
        return;
      }
      const parsed = parseIntegrationTestJson(text);
      if (!parsed) {
        setFeedback('error', 'Unexpected response from server.');
        return;
      }
      if (!parsed.success) {
        setFeedback('error', parsed.message);
        return;
      }
      if (parsed.warnings?.length) {
        setMsgTone('warning');
        setMsg(`${parsed.message} — ${parsed.warnings.join(' ')}`);
        return;
      }
      setFeedback('success', parsed.message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const body = shopifyRequestBody();
      if (!body.shopDomain) {
        setFeedback('error', 'Enter your myshopify.com shop domain.');
        return;
      }
      if (!body.accessToken && !connected) {
        setFeedback('error', 'Enter your Admin API access token to save.');
        return;
      }

      const res = await fetch('/api/tenant-integrations/shopify', {
        method: 'PUT',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        setFeedback('error', parseApiErrorMessage(text, res.status));
        return;
      }
      let shopFromRes: string | undefined;
      try {
        const j = JSON.parse(text) as { shopDomain?: string };
        shopFromRes = j.shopDomain;
      } catch {
        /* ignore */
      }
      setAccessToken('');
      setConnected(true);
      setLastOk(true);
      setLastTestAt(new Date().toISOString());
      void getTenantIntegrationSummary()
        .then((s) => {
          setTokenMasked(s.shopify.tokenMasked);
          setLastTestAt(s.shopify.lastTestAt);
        })
        .catch(() => {
          /* ignore */
        });
      setFeedback(
        'success',
        'Saved securely. The access token is encrypted and never shown again. A store record was created for this workspace.',
      );
      if (shopFromRes) setShopDomain(shopFromRes);
    } finally {
      setSaving(false);
    }
  }

  const lastTestLabel = formatIntegrationLastTested(lastTestAt);
  const hostForActions = normalizeShopifyIntegrationDomainInput(shopDomain);
  const tokenTyped = accessToken.trim().length > 0 && !looksLikeMaskedSecretOnly(accessToken);
  const canUseSavedToken = connected && !tokenTyped;
  const testEnabled =
    Boolean(hostForActions) && (tokenTyped || connected) && !testing && !saving;
  const saveEnabled =
    Boolean(hostForActions) && (tokenTyped || connected) && !testing && !saving;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Link href="/dashboard/settings" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
        ← Settings
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Shopify</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Admin API access for your myshopify.com store. Secrets are encrypted; after save, enter a new token only when
          rotating credentials.
        </p>
      </div>
      {summaryLoading ? (
        <p className="text-sm text-muted-foreground">Loading status…</p>
      ) : null}
      {summaryError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
          {summaryError}
        </div>
      ) : null}
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <p className="text-sm">
          <span className="text-muted-foreground">Status:</span>{' '}
          {connected ? (
            <span className="font-medium text-emerald-700 dark:text-emerald-400">Connected</span>
          ) : (
            <span className="font-medium text-amber-800 dark:text-amber-200">Not connected</span>
          )}
          {lastOk != null ? (
            <span className="ml-2 text-xs text-muted-foreground">(last test: {lastOk ? 'ok' : 'failed'})</span>
          ) : null}
        </p>
        {lastTestLabel ? (
          <p className="mt-1 text-xs text-muted-foreground">Last tested: {lastTestLabel}</p>
        ) : null}
        {tokenMasked ? (
          <p className="mt-1 text-xs font-mono text-muted-foreground">Saved token: {tokenMasked}</p>
        ) : null}
        <label className="mt-4 block text-sm font-medium">Shop domain</label>
        <input
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={shopDomain}
          onChange={(e) => setShopDomain(e.target.value)}
          placeholder="your-store.myshopify.com or https://your-store.myshopify.com/admin"
          autoComplete="off"
          spellCheck={false}
        />
        <label className="mt-4 block text-sm font-medium">Admin API access token</label>
        <p className="mt-1 text-xs text-muted-foreground">
          {canUseSavedToken
            ? 'Using saved token for Test/Save until you type a new token below.'
            : 'Enter a new access token to test or save. The field stays empty after save — saved secrets are never refilled here.'}
        </p>
        <input
          type="password"
          name="shopify-admin-token-new"
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder={connected ? 'Leave blank to use saved token, or paste a new shpat_…' : 'shpat_…'}
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {msg ? (
          <p
            className={`mt-3 text-sm ${
              msgTone === 'error'
                ? 'text-red-600 dark:text-red-400'
                : msgTone === 'success'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : msgTone === 'warning'
                    ? 'text-amber-800 dark:text-amber-200'
                    : 'text-muted-foreground'
            }`}
          >
            {msg}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!testEnabled}
            onClick={() => void test()}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            disabled={!saveEnabled}
            onClick={() => void save()}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
