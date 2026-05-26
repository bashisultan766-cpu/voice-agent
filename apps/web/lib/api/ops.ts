import { authenticatedFetch, authenticatedFetchJson } from '@/lib/api/authenticated-fetch';

const getBaseUrl = () =>
  typeof window !== 'undefined'
    ? ''
    : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

async function fetchOps<T>(path: string): Promise<T> {
  return authenticatedFetchJson<T>(`${getBaseUrl()}/api/ops/${path}`, { cache: 'no-store' });
}

async function postOps<T>(path: string, body: unknown): Promise<T> {
  return authenticatedFetchJson<T>(`${getBaseUrl()}/api/ops/${path}`, {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify(body),
  });
}

export interface OpsAgentOverview {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  shopifyConnectionStatus?: string | null;
  twilioConnectionStatus?: string | null;
  openaiConnectionStatus?: string | null;
  voiceProfile?: { provider?: string | null; language?: string | null } | null;
}

export interface OpsCall {
  id: string;
  fromNumber?: string | null;
  toNumber?: string | null;
  status: string;
  createdAt: string;
  durationSeconds?: number | null;
  agent?: { id: string; name: string } | null;
}

export interface OpsTranscript {
  id: string;
  role: string;
  content: string;
  sequenceNumber: number;
  createdAt: string;
}

export interface OpsLead {
  id: string;
  callSessionId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  intent?: string | null;
  createdAt: string;
  agent?: { id: string; name: string } | null;
}

export interface OpsCheckoutLink {
  id: string;
  callSessionId?: string | null;
  checkoutUrl: string;
  status: string;
  mode?: string;
  customerEmail?: string | null;
  createdAt: string;
  sentAt?: string | null;
  agent?: { id: string; name: string } | null;
}

export interface OpsEmailEvent {
  id: string;
  callSessionId?: string | null;
  recipientEmail: string;
  status: string;
  subject: string;
  provider?: string;
  createdAt: string;
  sentAt?: string | null;
  agent?: { id: string; name: string } | null;
}

export interface OpsPaymentRecord {
  id: string;
  paymentStatus: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  customerEmail?: string | null;
  shopifyOrderId?: string | null;
  shopifyOrderName?: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt?: string | null;
  failedAt?: string | null;
  expiredAt?: string | null;
  agent?: { id: string; name: string } | null;
  checkoutLink?: { id: string; checkoutUrl: string; callSessionId?: string | null } | null;
}

export function getOpsAgents() {
  return fetchOps<OpsAgentOverview[]>('agents');
}

export function getOpsCalls() {
  return fetchOps<OpsCall[]>('calls');
}

export function getOpsTranscripts(callId: string) {
  return fetchOps<OpsTranscript[]>(`calls/${encodeURIComponent(callId)}/transcripts`);
}

export function getOpsLeads() {
  return fetchOps<OpsLead[]>('leads');
}

export function getOpsCheckoutLinks() {
  return fetchOps<OpsCheckoutLink[]>('checkout-links');
}

export function getOpsEmailEvents() {
  return fetchOps<OpsEmailEvent[]>('email-events');
}

export function getOpsPayments() {
  return fetchOps<OpsPaymentRecord[]>('payments');
}

export interface OpsFullReadinessSmokeResponse {
  ok: boolean;
  agentId: string;
  agentName: string;
  summary: { passed: number; failed: number };
  expectedTwilioWebhook: { inbound: string; status: string; method: 'POST' };
  observedTwilioWebhook: {
    voiceUrl: string | null;
    voiceMethod: string | null;
    statusCallback: string | null;
    statusCallbackMethod: string | null;
  } | null;
  checks: Array<{ key: string; pass: boolean; details: string }>;
  flowSimulation?: unknown;
}

export function runOpsFullReadinessSmoke(
  agentId: string,
  body?: {
    query?: string;
    customerEmail?: string;
    runFlowSimulation?: boolean;
    sendEmail?: boolean;
    checkoutMode?: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
    callSessionId?: string;
  },
) {
  return postOps<OpsFullReadinessSmokeResponse>(
    `agents/${encodeURIComponent(agentId)}/full-readiness-smoke`,
    body ?? {},
  );
}
