'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  formatIntegrationLastTested,
  getTenantIntegrationSummary,
  parseIntegrationTestJson,
  saveTwilioSettings,
  testTwilioSettings,
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
  const [savedTokenMask, setSavedTokenMask] = useState<string | null>(null);
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
        setSavedTokenMask(s.twilio.authTokenMasked);
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

  function validateSid(value: string): string | null {
    if (!value.trim()) return 'Account SID is required.';
    if (!/^AC[a-z0-9]{32}$/i.test(value.trim())) {
      return 'Account SID should look like AC followed by 32 letters/numbers.';
    }
    return null;
  }

  function validatePhone(value: string): string | null {
    if (!value.trim()) return 'Phone number is required.';
    if (!/^\+[1-9]\d{6,14}$/.test(value.trim())) {
      return 'Phone number must be in E.164 format (e.g. +12512554549).';
    }
    return null;
  }

  async function handleTestConnectionClick() {
    const sidError = validateSid(accountSid);
    const phoneError = phoneNumber.trim() ? validatePhone(phoneNumber) : null;
    if (sidError || phoneError) {
      setFeedback('error', sidError ?? phoneError ?? 'Invalid Twilio settings.');
      return;
    }
    setTesting(true);
    setMsg(null);
    try {
      const res = await testTwilioSettings({
        accountSid: accountSid.trim(),
        phoneNumber: phoneNumber.trim(),
        ...(authToken.trim() ? { authToken: authToken.trim() } : {}),
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

  async function handleSaveClick() {
    const sidError = validateSid(accountSid);
    const phoneError = validatePhone(phoneNumber);
    if (sidError || phoneError) {
      setFeedback('error', sidError ?? phoneError ?? 'Invalid Twilio settings.');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await saveTwilioSettings({
        accountSid: accountSid.trim(),
        authToken: authToken.trim(),
        phoneNumber: phoneNumber.trim(),
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
      setSavedTokenMask(authToken.trim() ? `tw_****${authToken.trim().slice(-4)}` : 'tw_****saved');
      void getTenantIntegrationSummary()
        .then((s) => {
          setLastTestAt(s.twilio.lastTestAt);
          setSavedTokenMask(s.twilio.authTokenMasked);
        })
        .catch(() => {});
      setFeedback('success', `Saved: Yes · ${phoneNumber.trim()}`);
    } finally {
      setSaving(false);
    }
  }

  async function configureWebhook() {
    setMsg(null);
    const res = await fetch('/api/tenant-integrations/twilio/configure-webhook', {
      method: 'POST',
      credentials: 'include',
      headers: tenantIntegrationHeaders(),
    });
    const text = await res.text();
    if (!res.ok) {
      setFeedback('error', parseApiErrorMessage(text, res.status));
      return;
    }
    const payload = JSON.parse(text) as { webhook?: { inboundUrl?: string } };
    setFeedback(
      'success',
      `Webhook configured (POST). Inbound URL: ${payload.webhook?.inboundUrl ?? 'set'}`,
    );
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
        {savedTokenMask ? <p className="text-xs text-muted-foreground">Saved token: {savedTokenMask}</p> : null}
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
            disabled={testing || saving || !accountSid.trim()}
            onClick={() => void handleTestConnectionClick()}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            disabled={saving || testing || !accountSid.trim() || !phoneNumber.trim()}
            onClick={() => void handleSaveClick()}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving || testing || !connected}
            onClick={() => void configureWebhook()}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Configure Twilio Webhook
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Webhook route: <code>/api/twilio/voice/inbound</code> (POST)
        </p>
      </div>
    </div>
  );
}
