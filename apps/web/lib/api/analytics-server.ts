import { cookies } from 'next/headers';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

async function authHeaders(): Promise<Record<string, string>> {
  const token = (await cookies()).get('va_access_token')?.value;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${getServerApiBaseUrl()}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeaders()),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed request: ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchJsonSafe<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = await fetchJson<T>(path);
    return { ok: true, data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Request failed';
    return { ok: false, error: msg.length > 400 ? `${msg.slice(0, 400)}…` : msg };
  }
}

export type AnalyticsOverview = {
  totalCalls: number;
  resolutionRate: number;
  escalationRate: number;
  avgDurationSeconds: number;
  callbackRequestCount: number;
};

export type AgentMetric = {
  agentId: string;
  agentName: string;
  total: number;
  resolutionRate: number;
  escalationRate: number;
  avgDurationSeconds: number;
  avgToolCalls: number;
};

export type StoreMetric = {
  storeId: string;
  storeName: string;
  total: number;
  resolutionRate: number;
  escalationRate: number;
};

export type ToolMetric = {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatencyMs: number;
};

export type QaQueueCall = {
  id: string;
  status: string;
  endedAt: string | null;
  agent: { id: string; name: string };
  store: { id: string; name: string } | null;
  _count: { toolExecutions: number };
  callOutcome: { resolutionStatus: string } | null;
};

export type QaCallDetail = {
  id: string;
  status: string;
  durationSeconds: number | null;
  escalated: boolean;
  summary: string | null;
  callOutcome: {
    resolutionStatus: string;
    toolsUsedCount: number;
    toolFailuresCount: number;
    qaScore: number | null;
  } | null;
  agent: { id: string; name: string; baseSystemPrompt: string };
  store: { id: string; name: string } | null;
  transcripts: Array<{ role: string; content: string; sequenceNumber: number }>;
  toolExecutions: Array<{ toolName: string; status: string; latencyMs: number | null }>;
  callEvents: Array<{ type: string; timestamp: string }>;
};

export async function getAnalyticsOverview(): Promise<AnalyticsOverview> {
  return fetchJson<AnalyticsOverview>('/api/analytics/overview');
}

export async function getAnalyticsAgents(): Promise<AgentMetric[]> {
  return fetchJson<AgentMetric[]>('/api/analytics/agents');
}

export async function getAnalyticsStores(): Promise<StoreMetric[]> {
  return fetchJson<StoreMetric[]>('/api/analytics/stores');
}

export async function getAnalyticsTools(): Promise<ToolMetric[]> {
  return fetchJson<ToolMetric[]>('/api/analytics/tools');
}

export async function getQaQueueCalls(): Promise<QaQueueCall[]> {
  return fetchJson<QaQueueCall[]>('/api/qa/calls?limit=50');
}

export async function getQaCallDetail(callId: string): Promise<QaCallDetail> {
  return fetchJson<QaCallDetail>(`/api/qa/calls/${encodeURIComponent(callId)}`);
}
