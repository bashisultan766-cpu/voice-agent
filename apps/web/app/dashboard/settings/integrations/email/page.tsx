'use client';

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  formatIntegrationLastTested,
  getTenantIntegrationSummary,
  parseIntegrationTestJson,
  tenantIntegrationHeaders,
} from '@/lib/api/tenant-integrations';
import { parseApiErrorMessage } from '@/lib/api/error-message';

const emailSchema = z.string().trim().email();

export default function EmailIntegrationSettingsPage() {
  const loadGen = useRef(0);
  const [apiKey, setApiKey] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [testRecipientEmail, setTestRecipientEmail] = useState('');
  const [connected, setConnected] = useState(false);
  const [keyMasked, setKeyMasked] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const [lastTestAt, setLastTestAt] = useState<string | null>(null);
  const [savedFrom, setSavedFrom] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveMsgTone, setSaveMsgTone] = useState<'success' | 'error'>('success');
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testMsgTone, setTestMsgTone] = useState<'success' | 'error' | 'warning'>('success');

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

  const trimmedFromEmail = fromEmail.trim();
  const trimmedTestRecipient = testRecipientEmail.trim();
  const fromValid = emailSchema.safeParse(trimmedFromEmail).success;
  const testRecipientValid = emailSchema.safeParse(trimmedTestRecipient).success;
  const fromEmailError =
    trimmedFromEmail.length > 0 && !fromValid ? 'From email must be valid.' : null;
  const testRecipientError =
    trimmedTestRecipient.length > 0 && !testRecipientValid
      ? 'Test recipient email must be valid.'
      : null;
  const canSave = fromValid && (connected || Boolean(apiKey.trim()));
  const canTest = fromValid && testRecipientValid && (Boolean(apiKey.trim()) || connected);

  async function testConnection() {
    setTesting(true);
    setTestMsg(null);
    try {
      const body: { fromEmail: string; testRecipientEmail: string; apiKey?: string } = {
        fromEmail: trimmedFromEmail,
        testRecipientEmail: trimmedTestRecipient,
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();

      const res = await fetch('/api/tenant-integrations/email/test', {
        method: 'POST',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        setTestMsgTone('error');
        setTestMsg(parseApiErrorMessage(text, res.status));
        setLastOk(false);
        return;
      }
      const parsed = parseIntegrationTestJson(text);
      if (!parsed) {
        setTestMsgTone('error');
        setTestMsg('Unexpected response from server.');
        setLastOk(false);
        return;
      }
      if (!parsed.success) {
        setTestMsgTone('error');
        setTestMsg(parsed.message);
        setLastOk(false);
        void getTenantIntegrationSummary()
          .then((s) => {
            setLastOk(s.email.lastTestOk);
            setLastTestAt(s.email.lastTestAt);
          })
          .catch(() => {});
        return;
      }
      if (parsed.warnings?.length) {
        setTestMsgTone('warning');
        setTestMsg(`${parsed.message} — Note: ${parsed.warnings.join(' ')}`);
      } else {
        setTestMsgTone('success');
        setTestMsg(parsed.message);
      }
      setLastOk(true);
      setLastTestAt(new Date().toISOString());
      void getTenantIntegrationSummary()
        .then((s) => {
          setLastOk(s.email.lastTestOk ?? true);
          setLastTestAt(s.email.lastTestAt ?? new Date().toISOString());
        })
        .catch(() => {});
    } finally {
      setTesting(false);
    }
  }

  function handleTestConnectionClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!canTest || testing || saving) return;
    void testConnection();
  }

  async function saveCredentials() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: { apiKey?: string; fromEmail: string } = { fromEmail: trimmedFromEmail };
      if (apiKey.trim()) body.apiKey = apiKey.trim();

      const res = await fetch('/api/tenant-integrations/email', {
        method: 'PUT',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        setSaveMsgTone('error');
        setSaveMsg(parseApiErrorMessage(text, res.status));
        return;
      }
      setApiKey('');
      setConnected(true);
      setSavedFrom(trimmedFromEmail.toLowerCase());
      void getTenantIntegrationSummary()
        .then((s) => {
          setConnected(s.email.configured);
          setKeyMasked(s.email.keyMasked);
          setSavedFrom(s.email.fromEmail);
          setLastOk((prev) => (s.email.lastTestOk != null ? s.email.lastTestOk : prev));
          setLastTestAt((prev) => s.email.lastTestAt ?? prev);
        })
        .catch(() => {});
      setSaveMsgTone('success');
      setSaveMsg('Saved. Resend API key is encrypted and not shown again.');
    } finally {
      setSaving(false);
    }
  }

  function handleSaveSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSave || saving || testing) return;
    void saveCredentials();
  }

  const lastTestLabel = formatIntegrationLastTested(lastTestAt);

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
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="space-y-1 text-sm mb-3">
          <p>
            <span className="text-muted-foreground">Saved:</span>{' '}
            {connected ? (
              <span className="font-medium text-emerald-700 dark:text-emerald-400">Yes</span>
            ) : (
              <span className="font-medium text-amber-800 dark:text-amber-200">No</span>
            )}
            {savedFrom ? <span className="ml-2 text-xs text-muted-foreground">· {savedFrom}</span> : null}
          </p>
          <p>
            <span className="text-muted-foreground">Test:</span>{' '}
            {lastOk === true ? (
              <span className="font-medium text-emerald-700 dark:text-emerald-400">Successful</span>
            ) : lastOk === false ? (
              <span className="font-medium text-red-600 dark:text-red-400">Failed</span>
            ) : (
              <span className="font-medium text-muted-foreground">Not tested</span>
            )}
            {lastTestLabel ? (
              <span className="ml-2 text-xs text-muted-foreground">· {lastTestLabel}</span>
            ) : null}
          </p>
        </div>
        {keyMasked ? (
          <p className="text-xs font-mono text-muted-foreground mb-3">Saved API key: {keyMasked}</p>
        ) : null}

        <form onSubmit={handleSaveSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium" htmlFor="resend-api-key">
              Resend API key
            </label>
            <input
              id="resend-api-key"
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
            <label className="block text-sm font-medium" htmlFor="resend-from-email">
              From email
            </label>
            <input
              id="resend-from-email"
              type="email"
              className={`mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm ${
                fromEmailError ? 'border-red-500' : ''
              }`}
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="notifications@yourdomain.com"
              autoComplete="off"
              spellCheck={false}
            />
            {fromEmailError ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fromEmailError}</p>
            ) : null}
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="resend-test-recipient">
              Test recipient email
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Test connection sends to this address (not saved). Use your personal inbox, e.g. Gmail.
            </p>
            <input
              id="resend-test-recipient"
              type="email"
              className={`mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm ${
                testRecipientError ? 'border-red-500' : ''
              }`}
              value={testRecipientEmail}
              onChange={(e) => setTestRecipientEmail(e.target.value)}
              placeholder="you@gmail.com"
              autoComplete="off"
              spellCheck={false}
            />
            {testRecipientError ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{testRecipientError}</p>
            ) : null}
          </div>

          {saveMsg ? (
            <p
              className={`text-sm ${
                saveMsgTone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {saveMsg}
            </p>
          ) : null}
          {testMsg ? (
            <p
              className={`text-sm ${
                testMsgTone === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : testMsgTone === 'warning'
                    ? 'text-amber-800 dark:text-amber-200'
                    : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {testMsg}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              disabled={testing || saving || !canTest}
              onClick={handleTestConnectionClick}
              aria-busy={testing}
              className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {testing ? 'Testing...' : 'Test connection'}
            </button>
            <button
              type="submit"
              disabled={saving || testing || !canSave}
              aria-busy={saving}
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
