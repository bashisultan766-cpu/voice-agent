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

export default function TwilioIntegrationSettingsPage() {
  const loadGen = useRef(0);
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [connected, setConnected] = useState(false);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const [lastTestAt, setLastTestAt] = useState<string | null>(null);
  const [savedPhone, setSavedPhone] = useState<string | null>(null);
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
        setConnected(s.twilio.configured);
        setLastOk(s.twilio.lastTestOk);
        setLastTestAt(s.twilio.lastTestAt);
        setSavedPhone(s.twilio.phoneNumber);
        setPhoneNumber((prev) => (prev.trim() !== '' ? prev : s.twilio.phoneNumber || ''));
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
      const res = await fetch('/api/tenant-integrations/twilio/test', {
        method: 'POST',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify({
          accountSid: accountSid.trim(),
          authToken: authToken.trim(),
          phoneNumber: phoneNumber.trim() || undefined,
        }),
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
      setFeedback('success', parsed.message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/tenant-integrations/twilio', {
        method: 'PUT',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify({
          accountSid: accountSid.trim(),
          authToken: authToken.trim(),
          phoneNumber: phoneNumber.trim(),
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        setFeedback('error', parseApiErrorMessage(text, res.status));
        return;
      }
      setAuthToken('');
      setConnected(true);
      setLastOk(true);
      setLastTestAt(new Date().toISOString());
      setSavedPhone(phoneNumber.trim());
      void getTenantIntegrationSummary()
        .then((s) => setLastTestAt(s.twilio.lastTestAt))
        .catch(() => {});
      setFeedback('success', 'Saved securely. Auth token is encrypted and not shown again.');
    } finally {
      setSaving(false);
    }
  }

  const lastTestLabel = formatIntegrationLastTested(lastTestAt);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Link href="/dashboard/settings" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
        ← Settings
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Twilio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Account SID, auth token, and inbound phone number (E.164). The number must exist on this Twilio account.
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
            <span className="font-medium text-emerald-700 dark:text-emerald-400">Connected</span>
          ) : (
            <span className="font-medium text-amber-800 dark:text-amber-200">Not connected</span>
          )}
          {savedPhone ? <span className="ml-2 text-xs text-muted-foreground">· {savedPhone}</span> : null}
        </p>
        {lastTestLabel ? (
          <p className="text-xs text-muted-foreground">Last tested: {lastTestLabel}</p>
        ) : null}
        <div>
          <label className="block text-sm font-medium">Account SID</label>
          <input
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
            value={accountSid}
            onChange={(e) => setAccountSid(e.target.value)}
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Auth token</label>
          <input
            type="password"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder={connected ? 'Enter new token only when rotating' : ''}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Phone number</label>
          <input
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder={savedPhone ? savedPhone : '+15551234567'}
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
                  : 'text-muted-foreground'
            }`}
          >
            {msg}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            disabled={testing || saving || !accountSid.trim() || !authToken.trim()}
            onClick={() => void test()}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            disabled={saving || testing || !authToken.trim()}
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
