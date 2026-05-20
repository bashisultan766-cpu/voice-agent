'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  formatIntegrationLastTested,
  getTenantIntegrationSummary,
  parseIntegrationTestJson,
  tenantIntegrationHeaders,
} from '@/lib/api/tenant-integrations';
import { parseApiErrorMessage } from '@/lib/api/error-message';

export default function EmailIntegrationSettingsPage() {
  const loadGen = useRef(0);
  const [apiKey, setApiKey] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [connected, setConnected] = useState(false);
  const [keyMasked, setKeyMasked] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const [lastTestAt, setLastTestAt] = useState<string | null>(null);
  const [savedFrom, setSavedFrom] = useState<string | null>(null);
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
        setConnected(s.email.configured);
        setLastOk(s.email.lastTestOk);
        setLastTestAt(s.email.lastTestAt);
        setSavedFrom(s.email.fromEmail);
        setKeyMasked(s.email.keyMasked);
        setFromEmail((prev) => (prev.trim() !== '' ? prev : s.email.fromEmail || ''));
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

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const res = await fetch('/api/tenant-integrations/email/test', {
        method: 'POST',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify({ apiKey: apiKey.trim(), fromEmail: fromEmail.trim() }),
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
        setMsg(`${parsed.message} — Note: ${parsed.warnings.join(' ')}`);
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
      const body: { apiKey?: string; fromEmail: string } = { fromEmail: fromEmail.trim() };
      if (apiKey.trim()) body.apiKey = apiKey.trim();

      const res = await fetch('/api/tenant-integrations/email', {
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
      setApiKey('');
      setConnected(true);
      setLastOk(true);
      setLastTestAt(new Date().toISOString());
      setSavedFrom(fromEmail.trim().toLowerCase());
      void getTenantIntegrationSummary()
        .then((s) => {
          setKeyMasked(s.email.keyMasked);
          setLastTestAt(s.email.lastTestAt);
        })
        .catch(() => {});
      setFeedback('success', 'Saved securely. Resend API key is encrypted and not shown again.');
    } finally {
      setSaving(false);
    }
  }

  const lastTestLabel = formatIntegrationLastTested(lastTestAt);
  const fromValid = fromEmail.trim().includes('@');
  const canSave = fromValid && (connected || Boolean(apiKey.trim()));

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Link href="/dashboard/settings" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
        ← Settings
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Email (Resend)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Used for transactional email (e.g. checkout links). From-address must be allowed in your Resend domain setup.
        </p>
      </div>
      {summaryLoading ? <p className="text-sm text-muted-foreground">Loading status…</p> : null}
      {summaryError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
          {summaryError}
        </div>
      ) : null}
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
        <p className="text-sm">
          <span className="text-muted-foreground">Status:</span>{' '}
          {connected ? (
            <span className="font-medium text-emerald-700 dark:text-emerald-400">Configured</span>
          ) : (
            <span className="font-medium text-amber-800 dark:text-amber-200">Not configured</span>
          )}
          {savedFrom ? <span className="ml-2 text-xs text-muted-foreground">· {savedFrom}</span> : null}
        </p>
        {lastTestLabel ? (
          <p className="text-xs text-muted-foreground">Last tested: {lastTestLabel}</p>
        ) : null}
        {keyMasked ? (
          <p className="text-xs font-mono text-muted-foreground">Saved API key: {keyMasked}</p>
        ) : null}
        <div>
          <label className="block text-sm font-medium">Resend API key</label>
          <input
            type="password"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connected ? 'Enter new key only when rotating (optional)' : 're_…'}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="block text-sm font-medium">From email</label>
          <input
            type="email"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="notifications@yourdomain.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {msg ? (
          <p
            className={`text-sm ${
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
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            disabled={testing || saving || !apiKey.trim() || !fromValid}
            onClick={() => void test()}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            disabled={saving || testing || !canSave}
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
