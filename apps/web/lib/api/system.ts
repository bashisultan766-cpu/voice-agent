const getBaseUrl = () =>
  typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

export interface SystemHealth {
  ok?: boolean;
  status?: string;
  [key: string]: unknown;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const res = await fetch(`${getBaseUrl()}/api/health`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || `Health check failed (${res.status}).`);
  }
  return data as SystemHealth;
}

