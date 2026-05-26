import { authenticatedFetch, authenticatedFetchJson, getAuthenticatedHeaders } from '@/lib/api/authenticated-fetch';

const getBaseUrl = () =>
  typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

function getHeaders(): HeadersInit {
  return getAuthenticatedHeaders();
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
  return authenticatedFetchJson<ShopifyConnectionStatus>(
    `${getBaseUrl()}/api/integrations/shopify/status?agentId=${encodeURIComponent(agentId)}`,
    { cache: 'no-store' },
  );
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
  return authenticatedFetchJson<ShopifyWebhookHealth>(
    `${getBaseUrl()}/api/integrations/shopify/health?agentId=${encodeURIComponent(agentId)}`,
    { cache: 'no-store' },
  );
}

export async function disconnectShopify(agentId: string): Promise<void> {
  await authenticatedFetch(`${getBaseUrl()}/api/integrations/shopify/disconnect`, {
    method: 'POST',
    body: JSON.stringify({ agentId }),
  });
}

export function getShopifyOauthStartUrl(agentId: string, shopDomain: string): string {
  return `/api/integrations/shopify/oauth/start?agentId=${encodeURIComponent(agentId)}&shop=${encodeURIComponent(shopDomain)}`;
}

