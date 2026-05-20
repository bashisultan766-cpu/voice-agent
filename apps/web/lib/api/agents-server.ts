import { cookies } from 'next/headers';
import { getServerApiBaseUrl } from '@/lib/server-api-base';
import { parseApiErrorMessage } from '@/lib/api/error-message';
import { agentApisToListItems, type AgentApi, type AgentListItem } from './agents';

async function authHeaders(): Promise<Record<string, string>> {
  const token = (await cookies()).get('va_access_token')?.value;
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

/**
 * Server Components: load one agent from Nest.
 * We call the API URL directly (Bearer from cookie) instead of fetching same-origin `/api/agents/...`.
 * A loopback HTTP request to Next in dev is very slow (extra compile + nested request handling).
 */
export async function getAgentServer(id: string): Promise<AgentApi | null> {
  const safeId = encodeURIComponent(id);
  let res: Response;
  try {
    res = await fetch(`${getServerApiBaseUrl()}/api/agents/${safeId}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },
      cache: 'no-store',
    });
  } catch (err) {
    const base = getServerApiBaseUrl();
    const msg =
      err instanceof Error ? err.message : 'fetch_failed';
    throw new Error(
      `Could not reach API at ${base}. Check INTERNAL_API_URL / NEXT_PUBLIC_API_URL and that the API is running. (${msg})`,
    );
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to load agent: ${res.status}`);
  }
  return res.json() as Promise<AgentApi>;
}

function parseAgentsListError(res: Response, text: string): string {
  return parseApiErrorMessage(text, res.status);
}

/**
 * Server Components: load agents list from Nest (Bearer from cookie).
 * Avoids a client-only fetch that can feel stuck on slow or flaky hydration.
 */
export async function getAgentsServer(): Promise<{ items: AgentListItem[]; error: string | null }> {
  try {
    const res = await fetch(`${getServerApiBaseUrl()}/api/agents`, {
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return { items: [], error: parseAgentsListError(res, text) };
    }
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : [];
    } catch {
      return { items: [], error: 'Invalid agents response from API.' };
    }
    if (!Array.isArray(data)) {
      return { items: [], error: 'Invalid agents response from API.' };
    }
    return { items: agentApisToListItems(data as AgentApi[]), error: null };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Could not reach the API. Check INTERNAL_API_URL / NEXT_PUBLIC_API_URL and that the API is running.';
    return { items: [], error: message };
  }
}
