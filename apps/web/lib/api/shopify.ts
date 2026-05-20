import { getBearerInit } from '@/lib/auth/browser-session';

const getBaseUrl = () =>
  typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

function getHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...getBearerInit(),
  };
}

export interface ShopifyConnectionStatus {
  agentId: string;
  agentName: string;
  connected: boolean;
  shopDomain: string | null;
  status: 'UNKNOWN' | 'OK' | 'FAILED';
  lastConnectionTestAt: string | null;
  webhookTopics: string[];
}

export async function getShopifyConnectionStatus(agentId: string): Promise<ShopifyConnectionStatus> {
  const res = await fetch(`${getBaseUrl()}/api/integrations/shopify/status?agentId=${encodeURIComponent(agentId)}`, {
    headers: getHeaders(),
    cache: 'no-store',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || 'Failed to load Shopify connection status.');
  }
  return data as ShopifyConnectionStatus;
}

export type ShopifyWebhookTopic =
  | 'orders/create'
  | 'carts/create'
  | 'orders/updated'
  | 'products/create'
  | 'products/update'
  | 'customers/create'
  | 'customers/update';

export interface ShopifyWebhookHealth {
  agentId: string;
  connected: boolean;
  shopDomain: string | null;
  lastSyncedAt: string | null;
  lastReceivedAtByTopic: Record<ShopifyWebhookTopic, string | null>;
  lastFailureAtByTopic: Record<ShopifyWebhookTopic, string | null>;
  failureCount24hByTopic: Record<ShopifyWebhookTopic, number>;
  totalFailures24h: number;
  freshness: 'fresh' | 'ok' | 'stale' | 'disconnected';
  latestReceivedAt: string | null;
}

export async function getShopifyWebhookHealth(agentId: string): Promise<ShopifyWebhookHealth> {
  const res = await fetch(`${getBaseUrl()}/api/integrations/shopify/health?agentId=${encodeURIComponent(agentId)}`, {
    headers: getHeaders(),
    cache: 'no-store',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || 'Failed to load Shopify webhook health.');
  }
  return data as ShopifyWebhookHealth;
}

export async function disconnectShopify(agentId: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/integrations/shopify/disconnect`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ agentId }),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || 'Failed to disconnect Shopify.');
  }
}

export function getShopifyOauthStartUrl(agentId: string, shopDomain: string): string {
  return `/api/integrations/shopify/oauth/start?agentId=${encodeURIComponent(agentId)}&shop=${encodeURIComponent(shopDomain)}`;
}

