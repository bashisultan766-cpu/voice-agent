'use client';

import { useEffect, useState } from 'react';
import {
  parseIntegrationTestJson,
  tenantIntegrationHeaders,
} from '@/lib/api/tenant-integrations';
import { parseApiErrorMessage } from '@/lib/api/error-message';
import { getAgents } from '@/lib/api/agents';
import { authenticatedFetch } from '@/lib/api/authenticated-fetch';

type AgentOption = { id: string; name: string };

export function VoiceIntegrationsTestPanel() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<'success' | 'error' | 'neutral'>('neutral');
  const [loading, setLoading] = useState<'openai' | 'elevenlabs' | 'flow' | null>(null);

  useEffect(() => {
    void getAgents()
      .then((rows) => {
        const mapped = rows.map((a) => ({ id: a.id, name: a.name }));
        setAgents(mapped);
        if (mapped.length === 1) setAgentId(mapped[0]!.id);
      })
      .catch(() => {});
  }, []);

  function setFeedback(tone: typeof msgTone, text: string) {
    setMsgTone(tone);
    setMsg(text);
  }

  async function testOpenAI() {
    setLoading('openai');
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
      if (!parsed?.success) {
        setFeedback('error', parsed?.message ?? 'Test failed.');
        return;
      }
      setFeedback('success', parsed.message);
    } finally {
      setLoading(null);
    }
  }

  async function testElevenLabs() {
    setLoading('elevenlabs');
    setMsg(null);
    try {
      const res = await fetch('/api/tenant-integrations/elevenlabs/test', {
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
      if (!parsed?.success) {
        setFeedback('error', parsed?.message ?? 'Test failed.');
        return;
      }
      setFeedback('success', parsed.message);
    } finally {
      setLoading(null);
    }
  }

  async function testFullVoiceFlow() {
    if (!agentId.trim()) {
      setFeedback('error', 'Select an agent first.');
      return;
    }
    setLoading('flow');
    setMsg(null);
    try {
      const res = await authenticatedFetch(`/api/agents/${encodeURIComponent(agentId)}/smoke-test`, {
        method: 'POST',
        headers: tenantIntegrationHeaders(),
        body: JSON.stringify({
          sampleSpeechResult: 'I need help finding a product.',
        }),
      });
      const text = await res.text();
      let body: { ok?: boolean; checks?: Array<{ key: string; pass: boolean; details: string }>; note?: string } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        setFeedback('error', parseApiErrorMessage(text, res.status));
        return;
      }
      if (!res.ok) {
        setFeedback('error', (body as { message?: string }).message ?? parseApiErrorMessage(text, res.status));
        return;
      }
      const failed = (body.checks ?? []).filter((c) => !c.pass);
      if (!body.ok || failed.length) {
        setFeedback(
          'error',
          `Smoke test incomplete. Failed: ${failed.map((f) => f.key).join(', ') || 'see API logs'}.`,
        );
        return;
      }
      setFeedback('success', body.note ?? 'Voice flow smoke checks passed.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-sm font-semibold">Voice integration tests</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Test OpenAI uses the saved workspace key. Test ElevenLabs uses saved workspace voice settings. Full flow runs
        non-destructive smoke checks for the selected agent.
      </p>
      <label className="mt-3 block text-xs font-medium text-muted-foreground">Agent (for full flow)</label>
      <select
        className="mt-1 w-full max-w-md rounded-md border bg-background px-3 py-2 text-sm"
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
      >
        <option value="">— Select agent —</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={loading !== null}
          onClick={() => void testOpenAI()}
          className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {loading === 'openai' ? 'Testing…' : 'Test OpenAI Key'}
        </button>
        <button
          type="button"
          disabled={loading !== null}
          onClick={() => void testElevenLabs()}
          className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {loading === 'elevenlabs' ? 'Testing…' : 'Test ElevenLabs Voice'}
        </button>
        <button
          type="button"
          disabled={loading !== null || !agentId.trim()}
          onClick={() => void testFullVoiceFlow()}
          className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {loading === 'flow' ? 'Running…' : 'Test Full Voice Flow'}
        </button>
      </div>
      {msg ? (
        <p
          className={`mt-3 text-sm ${
            msgTone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
          }`}
        >
          {msg}
        </p>
      ) : null}
    </div>
  );
}
