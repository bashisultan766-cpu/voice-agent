'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  formatIntegrationLastTested,
  getTenantIntegrationSummary,
  looksLikeMaskedSecretOnly,
  parseIntegrationTestJson,
  tenantIntegrationHeaders,
} from '@/lib/api/tenant-integrations';
import { parseApiErrorMessage } from '@/lib/api/error-message';

export default function ElevenLabsIntegrationSettingsPage() {
  const loadGen = useRef(0);
  const [apiKey, setApiKey] = useState('');
  const [defaultVoiceId, setDefaultVoiceId] = useState('');
  const [defaultModel, setDefaultModel] = useState('eleven_multilingual_v2');
  const [connected, setConnected] = useState(false);
  const [keyMasked, setKeyMasked] = useState<string | null>(null);
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
        setConnected(s.elevenlabs.configured);
        setKeyMasked(s.elevenlabs.keyMasked);
        setLastOk(s.elevenlabs.lastTestOk);
        setLastTestAt(s.elevenlabs.lastTestAt);
        if (s.elevenlabs.defaultVoiceId) setDefaultVoiceId((prev) => (prev.trim() ? prev : s.elevenlabs.defaultVoiceId as string));
        if (s.elevenlabs.defaultModel) setDefaultModel((prev) => (prev.trim() ? prev : s.elevenlabs.defaultModel as string));
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
    const trimmedApiKey = apiKey.trim();
    const maskedInput = trimmedApiKey.length > 0 && looksLikeMaskedSecretOnly(trimmedApiKey);
    const useSavedKey = !trimmedApiKey || maskedInput;
    if (maskedInput && !connected) {
      setFeedback('error', 'Enter your real ElevenLabs API key, not masked placeholder characters.');
      return;
    }
    if (useSavedKey && !connected) {
      setFeedback('error', 'Enter an ElevenLabs API key to test the connection.');
      return;
    }
    setTesting(true);
    setMsg(null);
    try {
      const res = await fetch('/api/tenant-integrations/elevenlabs/test', {
        method: 'POST',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify({
          apiKey: useSavedKey ? undefined : trimmedApiKey,
          voiceId: defaultVoiceId.trim() || undefined,
          model: defaultModel.trim() || undefined,
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
      const scope = useSavedKey ? 'saved key' : 'newly entered key';
      if (parsed.warnings?.length) {
        setFeedback('warning', `${parsed.message} (${scope}). Warnings: ${parsed.warnings.join(' ')}`);
        return;
      }
      setFeedback('success', `${parsed.message} (${scope}).`);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    const trimmedApiKey = apiKey.trim();
    const maskedInput = trimmedApiKey.length > 0 && looksLikeMaskedSecretOnly(trimmedApiKey);
    const useSavedKey = !trimmedApiKey || maskedInput;
    if (maskedInput && !connected) {
      setFeedback('error', 'Enter your real ElevenLabs API key, not masked placeholder characters.');
      return;
    }
    if (useSavedKey && !connected) {
      setFeedback('error', 'Enter an ElevenLabs API key before saving.');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/tenant-integrations/elevenlabs', {
        method: 'PUT',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify({
          apiKey: useSavedKey ? undefined : trimmedApiKey,
          defaultVoiceId: defaultVoiceId.trim() || undefined,
          defaultModel: defaultModel.trim() || undefined,
        }),
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
      void getTenantIntegrationSummary()
        .then((s) => {
          setKeyMasked(s.elevenlabs.keyMasked);
          setLastTestAt(s.elevenlabs.lastTestAt);
        })
        .catch(() => {});
      const scope = useSavedKey ? 'saved key' : 'newly entered key';
      setFeedback('success', `Saved securely using ${scope}. ElevenLabs key is encrypted and never shown again.`);
    } finally {
      setSaving(false);
    }
  }

  const lastTestLabel = formatIntegrationLastTested(lastTestAt);
  const testEnabled = Boolean(apiKey.trim() || connected);
  const canSave = connected || Boolean(apiKey.trim());

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Link href="/dashboard/settings" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
        ← Settings
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">ElevenLabs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Save one workspace key for premium natural voice output across multiple agents.
        </p>
      </div>
      {summaryLoading ? <p className="text-sm text-muted-foreground">Loading status…</p> : null}
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
        {lastTestLabel ? <p className="mt-1 text-xs text-muted-foreground">Last tested: {lastTestLabel}</p> : null}
        {keyMasked ? <p className="mt-1 text-xs font-mono text-muted-foreground">Saved key: {keyMasked}</p> : null}

        <label className="mt-4 block text-sm font-medium">ElevenLabs API key</label>
        <input
          type="password"
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={connected ? 'Enter new key only when rotating (optional)' : 'xi-...'}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {apiKey.trim()
            ? 'Testing/saving uses the key you typed above.'
            : connected
              ? 'Testing/saving uses your existing saved workspace key.'
              : 'Enter a new ElevenLabs key to test or save.'}
        </p>

        <label className="mt-4 block text-sm font-medium">Default voice ID</label>
        <input
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
          value={defaultVoiceId}
          onChange={(e) => setDefaultVoiceId(e.target.value)}
          placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
          autoComplete="off"
          spellCheck={false}
        />

        <label className="mt-4 block text-sm font-medium">Default model</label>
        <select
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
        >
          <option value="eleven_multilingual_v2">eleven_multilingual_v2 (recommended)</option>
          <option value="eleven_turbo_v2_5">eleven_turbo_v2_5</option>
          <option value="eleven_flash_v2_5">eleven_flash_v2_5</option>
        </select>

        {msg ? (
          <p
            className={`mt-3 text-sm ${
              msgTone === 'error'
                ? 'text-red-600 dark:text-red-400'
                : msgTone === 'success'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : msgTone === 'warning'
                    ? 'text-amber-700 dark:text-amber-300'
                    : 'text-muted-foreground'
            }`}
          >
            {msg}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={testing || saving || !testEnabled}
            onClick={() => void test()}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test ElevenLabs Voice'}
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
