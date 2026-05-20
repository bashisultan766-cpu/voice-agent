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

type VoiceConfigCheck = {
  resolvedAgentId?: string;
  openaiKeySource?: string;
  openaiKeyPresent?: boolean;
  voiceProvider?: string | null;
  voiceIdPresent?: boolean;
  model?: string | null;
  elevenLabsKeySource?: string;
  agentOverridesWorkspaceOpenai?: boolean;
  warnings?: string[];
};

export default function OpenAIIntegrationSettingsPage() {
  const loadGen = useRef(0);
  const [apiKey, setApiKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [keyMasked, setKeyMasked] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const [lastTestAt, setLastTestAt] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingSaved, setTestingSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<'success' | 'error' | 'neutral' | 'warning'>('neutral');
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [checkAgentId, setCheckAgentId] = useState('');
  const [configCheck, setConfigCheck] = useState<VoiceConfigCheck | null>(null);
  const [configCheckLoading, setConfigCheckLoading] = useState(false);

  useEffect(() => {
    const id = ++loadGen.current;
    setSummaryLoading(true);
    setSummaryError(null);
    void getTenantIntegrationSummary()
      .then((s) => {
        if (id !== loadGen.current) return;
        setConnected(s.openai.configured);
        setLastOk(s.openai.lastTestOk);
        setLastTestAt(s.openai.lastTestAt);
        setKeyMasked(s.openai.keyMasked);
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

  useEffect(() => {
    void fetch('/api/agents', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [];
        const mapped = list
          .filter((a): a is { id: string; agentName?: string; name?: string } => Boolean(a && typeof a === 'object' && 'id' in a))
          .map((a) => ({ id: String(a.id), name: String(a.agentName ?? a.name ?? a.id) }));
        setAgents(mapped);
        if (mapped.length === 1) setCheckAgentId(mapped[0]!.id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!checkAgentId.trim()) {
      setConfigCheck(null);
      return;
    }
    setConfigCheckLoading(true);
    void fetch(`/api/voice/config-check?agentId=${encodeURIComponent(checkAgentId)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as VoiceConfigCheck | { error?: string } | null;
        if (!r.ok) return null;
        return j;
      })
      .then((j) => {
        if (j && !('error' in j && j.error === 'agentId_required')) setConfigCheck(j as VoiceConfigCheck);
        else setConfigCheck(null);
      })
      .finally(() => setConfigCheckLoading(false));
  }, [checkAgentId]);

  function setFeedback(tone: typeof msgTone, text: string) {
    setMsgTone(tone);
    setMsg(text);
  }

  function normalizedApiKeyInput(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    // Never forward UI masks/bullets as a secret.
    if (/^[\u2022\u00B7\u2219•·\*\u25CF●○◦\s]+$/.test(trimmed)) return '';
    if (/^\.+$/.test(trimmed)) return '';
    if (/^(sk|sk-proj)-[•·\*\s]+$/i.test(trimmed)) return '';
    return trimmed;
  }

  function looksMaskedOrPlaceholderOnly(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    return normalizedApiKeyInput(trimmed).length === 0;
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const apiKeyOut = normalizedApiKeyInput(apiKey);
      if (!apiKeyOut && !connected) {
        setFeedback(
          'warning',
          looksMaskedOrPlaceholderOnly(apiKey)
            ? 'That looks like a masked placeholder, not a real API key. Paste the actual OpenAI key (starts with sk- or sk-proj-).'
            : 'Enter an OpenAI API key first.',
        );
        return;
      }
      const res = await fetch('/api/tenant-integrations/openai/test', {
        method: 'POST',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify(apiKeyOut ? { apiKey: apiKeyOut } : {}),
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
      const body: { apiKey?: string } = {};
      const apiKeyOut = normalizedApiKeyInput(apiKey);
      if (apiKeyOut) body.apiKey = apiKeyOut;
      if (!apiKeyOut && !connected) {
        setFeedback(
          'warning',
          looksMaskedOrPlaceholderOnly(apiKey)
            ? 'That looks like a masked placeholder, not a real API key. Paste the actual OpenAI key (starts with sk- or sk-proj-).'
            : 'Enter an OpenAI API key first.',
        );
        return;
      }

      const res = await fetch('/api/tenant-integrations/openai', {
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
      let keyPresent = false;
      try {
        const j = JSON.parse(text) as { keyPresent?: boolean };
        keyPresent = Boolean(j.keyPresent);
      } catch {
        /* plain ok */
      }
      setApiKey('');
      setConnected(true);
      setLastOk(true);
      setLastTestAt(new Date().toISOString());
      void getTenantIntegrationSummary()
        .then((s) => {
          setKeyMasked(s.openai.keyMasked);
          setLastTestAt(s.openai.lastTestAt);
        })
        .catch(() => {});
      setFeedback(
        'success',
        keyPresent
          ? 'Saved securely. Key encrypted, decrypt verified, and not returned to the browser.'
          : 'Saved securely. API key is encrypted and not shown again.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function testSavedKey() {
    setTestingSaved(true);
    setMsg(null);
    try {
      const res = await fetch('/api/tenant-integrations/openai/test-saved', {
        method: 'POST',
        credentials: 'include',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify({}),
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
      setTestingSaved(false);
    }
  }

  const lastTestLabel = formatIntegrationLastTested(lastTestAt);
  const hasAnyInput = apiKey.trim().length > 0;
  const canSave = connected ? true : hasAnyInput;
  const canTest = connected ? true : hasAnyInput;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Link href="/dashboard/settings" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
        ← Settings
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">OpenAI</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace-level API key for voice/runtime. Precedence for live calls: per-agent OpenAI key (if set) → this
          workspace key → server <code className="text-xs">OPENAI_API_KEY</code>. Clear the agent key to use this
          workspace key.
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
            <span className="font-medium text-emerald-700 dark:text-emerald-400">Key on file</span>
          ) : (
            <span className="font-medium text-amber-800 dark:text-amber-200">No workspace key</span>
          )}
          {lastOk != null ? (
            <span className="ml-2 text-xs text-muted-foreground">(last test: {lastOk ? 'ok' : 'failed'})</span>
          ) : null}
        </p>
        {lastTestLabel ? (
          <p className="mt-1 text-xs text-muted-foreground">Last tested: {lastTestLabel}</p>
        ) : null}
        {keyMasked ? (
          <p className="mt-1 text-xs font-mono text-muted-foreground">Saved key: {keyMasked}</p>
        ) : null}
        <label className="mt-4 block text-sm font-medium">API key</label>
        <input
          type="password"
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={connected ? 'Enter new key only when rotating (optional — re-test saved key)' : 'sk-…'}
          autoComplete="off"
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
            disabled={testing || saving || !canTest}
            onClick={() => void test()}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test OpenAI Key'}
          </button>
          <button
            type="button"
            disabled={testingSaved || saving || !connected}
            onClick={() => void testSavedKey()}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            title="Calls OpenAI using the encrypted workspace key on file (no key sent from this page)."
          >
            {testingSaved ? 'Testing…' : 'Test saved workspace key'}
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

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">Active key source (per agent)</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose an agent to see which OpenAI credential wins for phone calls. No secrets are returned.
        </p>
        <label className="mt-3 block text-sm font-medium">Agent</label>
        <select
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={checkAgentId}
          onChange={(e) => setCheckAgentId(e.target.value)}
        >
          <option value="">— Select —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {configCheckLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
        ) : configCheck?.openaiKeySource ? (
          <ul className="mt-3 space-y-1 text-sm">
            {configCheck.agentOverridesWorkspaceOpenai ? (
              <li
                className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
                role="status"
              >
                Agent key overrides workspace key.
              </li>
            ) : null}
            <li>
              <span className="text-muted-foreground">OpenAI key source:</span>{' '}
              <span className="font-mono text-xs">{configCheck.openaiKeySource}</span>
            </li>
            <li>
              <span className="text-muted-foreground">Key present:</span>{' '}
              {configCheck.openaiKeyPresent ? 'yes' : 'no'}
            </li>
            <li>
              <span className="text-muted-foreground">Model:</span>{' '}
              <span className="font-mono text-xs">{configCheck.model ?? '—'}</span>
            </li>
            <li>
              <span className="text-muted-foreground">Voice provider:</span>{' '}
              <span className="font-mono text-xs">{configCheck.voiceProvider ?? '—'}</span>
            </li>
            <li>
              <span className="text-muted-foreground">Voice ID present:</span>{' '}
              {configCheck.voiceIdPresent ? 'yes' : 'no'}
            </li>
            <li>
              <span className="text-muted-foreground">ElevenLabs key source:</span>{' '}
              <span className="font-mono text-xs">{configCheck.elevenLabsKeySource ?? '—'}</span>
            </li>
            {configCheck.warnings?.length ? (
              <li className="text-amber-800 dark:text-amber-200">
                {configCheck.warnings.map((w) => (
                  <div key={w} className="text-xs">
                    {w}
                  </div>
                ))}
              </li>
            ) : null}
          </ul>
        ) : checkAgentId ? (
          <p className="mt-2 text-xs text-muted-foreground">Could not load diagnostic.</p>
        ) : null}
      </div>
    </div>
  );
}
