import { cookies } from 'next/headers';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

async function authHeaders(): Promise<Record<string, string>> {
  const token = (await cookies()).get('va_access_token')?.value;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchKnowledge<T>(path: string): Promise<T> {
  const res = await fetch(`${getServerApiBaseUrl()}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeaders()),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Knowledge request failed: ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchKnowledgeSafe<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = await fetchKnowledge<T>(path);
    return { ok: true, data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Request failed';
    return { ok: false, error: msg.length > 400 ? `${msg.slice(0, 400)}…` : msg };
  }
}

export type KnowledgeDocument = {
  id: string;
  title: string;
  type: string;
  status: string;
  storeId: string;
  vectorFileId?: string | null;
  vectorStoreId?: string | null;
};

export type BranchProfile = {
  id: string;
  name: string;
  city?: string | null;
  area?: string | null;
  phone?: string | null;
  isActive: boolean;
};

export type StoreFaq = {
  id: string;
  question: string;
  answer: string;
  isActive: boolean;
};

export async function getKnowledgeDocuments(): Promise<KnowledgeDocument[]> {
  return fetchKnowledge<KnowledgeDocument[]>('/api/knowledge/documents');
}

export async function getKnowledgeBranches(): Promise<BranchProfile[]> {
  return fetchKnowledge<BranchProfile[]>('/api/knowledge/branches');
}

export async function getKnowledgeFaqs(): Promise<StoreFaq[]> {
  return fetchKnowledge<StoreFaq[]>('/api/knowledge/faqs');
}
