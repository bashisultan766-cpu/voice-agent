import { getBearerInit } from '@/lib/auth/browser-session';

const getBaseUrl = () =>
  typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

export interface ClientListItem {
  id: string;
  name: string;
}

export interface StoreListItem {
  id: string;
  name: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...getBearerInit() },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function rowToIdName(row: unknown): { id: string; name: string } | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const name = r.name;
  if (typeof id !== 'string' || !id.trim()) return null;
  return {
    id: id.trim(),
    name: typeof name === 'string' && name.trim() ? name.trim() : id.trim(),
  };
}

export async function getClients(): Promise<ClientListItem[]> {
  const raw = await fetchJson<unknown>('/api/clients');
  if (!Array.isArray(raw)) return [];
  const out: ClientListItem[] = [];
  for (const row of raw) {
    const item = rowToIdName(row);
    if (item) out.push(item);
  }
  return out;
}

export async function getStores(): Promise<StoreListItem[]> {
  const raw = await fetchJson<unknown>('/api/stores');
  if (!Array.isArray(raw)) return [];
  const out: StoreListItem[] = [];
  for (const row of raw) {
    const item = rowToIdName(row);
    if (item) out.push(item);
  }
  return out;
}
