/**
 * Agents API client. Browser calls same-origin `/api/agents` (Next route forwards cookie → JWT).
 * For Server Components use `getAgentServer` from `@/lib/api/agents-server`.
 */
import { toCheckoutModeForm, normalizePhoneNumber } from '@bookstore-voice-agents/types';
import { clearClientSession, getBearerInit } from '@/lib/auth/browser-session';
import { parseApiErrorMessage } from '@/lib/api/error-message';

const getBaseUrl = () =>
  typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

function getHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...getBearerInit(),
  };
}

export type AgentStatusApi = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'DISABLED';

export type ConnectionStatusApi = 'UNKNOWN' | 'OK' | 'FAILED';

export interface AgentApi {
  id: string;
  clientId?: string | null;
  storeId?: string | null;
  catalogReady?: boolean;
  catalogLastSyncedAt?: string | null;
  catalogItemCount?: number;
  name: string;
  slug: string;
  status: AgentStatusApi;
  storeName?: string | null;
  storeUrl?: string | null;
  shopifyStoreNumber?: string | null;
  language: string;
  timezone?: string | null;
  voiceProvider?: string | null;
  voiceId?: string | null;
  voiceStyle?: string | null;
  shopifyConnectionStatus?: ConnectionStatusApi | null;
  databaseConnectionStatus?: ConnectionStatusApi | null;
  twilioConnectionStatus?: ConnectionStatusApi | null;
  openaiConnectionStatus?: ConnectionStatusApi | null;
  elevenlabsConnectionStatus?: ConnectionStatusApi | null;
  agentConfig?: {
    businessName?: string | null;
    supportEmail?: string | null;
    supportPhone?: string | null;
    askEmailBeforePaymentLink?: boolean | null;
    checkoutMode?: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE' | null;
    humanHandoffRules?: string | null;
    shippingPolicy?: string | null;
    returnPolicy?: string | null;
    exchangePolicy?: string | null;
    deliveryNotes?: string | null;
    forbiddenBehaviors?: string | null;
    escalationRules?: string | null;
  } | null;
  voiceProfile?: {
    providerConfig?: {
      elevenlabsModel?: string | null;
      languageMode?: 'auto' | 'fixed' | null;
      fixedLanguage?: string | null;
      supportedLanguages?: string[] | null;
      voiceStyle?: string | null;
    } | null;
  } | null;
  /** ISO timestamp of last connection test run on save, if any. */
  lastConnectionTestAt?: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export type UpdatedSecretsMeta = Partial<
  Record<
    | 'shopifyAdminToken'
    | 'shopifyApiKey'
    | 'shopifyApiSecret'
    | 'webhookSecret'
    | 'databaseUrl'
    | 'databaseAccessToken'
    | 'twilioAccountSid'
    | 'twilioAuthToken'
    | 'openaiApiKey'
    | 'elevenlabsApiKey',
    boolean
  >
>;

export interface AgentReadinessCheck {
  key: string;
  label: string;
  pass: boolean;
  fixAction: string;
}

export interface AgentReadinessResponse {
  ready: boolean;
  status: 'READY' | 'CONFIG_REQUIRED';
  checks: AgentReadinessCheck[];
  failures: Array<{ key: string; label: string; fixAction: string }>;
  expectedTwilioWebhookUrls: {
    inbound: string;
    status: string;
    method: 'POST';
  };
  observedTwilioWebhook: {
    voiceUrl: string | null;
    statusCallback: string | null;
    voiceMethod: string | null;
    statusCallbackMethod: string | null;
    sid: string;
  } | null;
}

/** Map API status to list/table status. */
export function mapStatus(status: AgentStatusApi): 'draft' | 'active' | 'paused' {
  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'PAUSED':
      return 'paused';
    default:
      return 'draft';
  }
}

export type ConnectionStatus = 'unknown' | 'ok' | 'failed';

export interface AgentListItem {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused';
  storeName?: string;
  voice?: string;
  shopifyConnectionStatus: ConnectionStatus;
  databaseConnectionStatus: ConnectionStatus;
  twilioConnectionStatus: ConnectionStatus;
  openaiConnectionStatus: ConnectionStatus;
  elevenlabsConnectionStatus: ConnectionStatus;
  catalogReady: boolean;
  catalogLastSyncedAt?: string | null;
  catalogItemCount: number;
  updatedAt: string;
}

export function mapConnectionStatus(s?: ConnectionStatusApi | null): ConnectionStatus {
  if (s === 'OK') return 'ok';
  if (s === 'FAILED') return 'failed';
  return 'unknown';
}

/** Shared mapping for list/table rows (browser and Server Components). */
export function agentApisToListItems(data: AgentApi[]): AgentListItem[] {
  return data.map((a) => {
    const voice = [a.voiceProvider, a.voiceId, a.voiceStyle].filter(Boolean).join(' ') || undefined;
    return {
      id: a.id,
      name: a.name,
      status: mapStatus(a.status),
      storeName: a.storeName ?? undefined,
      voice,
      shopifyConnectionStatus: mapConnectionStatus(a.shopifyConnectionStatus),
      databaseConnectionStatus: mapConnectionStatus(a.databaseConnectionStatus),
      twilioConnectionStatus: mapConnectionStatus(a.twilioConnectionStatus),
      openaiConnectionStatus: mapConnectionStatus(a.openaiConnectionStatus),
      elevenlabsConnectionStatus: mapConnectionStatus(a.elevenlabsConnectionStatus),
      catalogReady: a.catalogReady === true,
      catalogLastSyncedAt: a.catalogLastSyncedAt ?? null,
      catalogItemCount: a.catalogItemCount ?? 0,
      updatedAt: a.updatedAt,
    };
  });
}

async function parseErrorResponse(res: Response): Promise<string> {
  const text = await res.text();
  return parseApiErrorMessage(text, res.status);
}

function handleUnauthorized(res: Response): never | void {
  if (res.status !== 401) return;
  if (typeof window !== 'undefined') {
    clearClientSession();
    window.location.href = '/login?reason=session-expired';
    throw new Error('Session expired, please login again.');
  }
  throw new Error('Session expired, please login again.');
}

export async function getAgents(): Promise<AgentListItem[]> {
  const res = await fetch(`${getBaseUrl()}/api/agents`, {
    headers: getHeaders(),
    cache: 'no-store',
    credentials: 'include',
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const message = await parseErrorResponse(res);
    throw new Error(message);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('Invalid agents response from server.');
  }
  return agentApisToListItems(data as AgentApi[]);
}

export async function getAgent(id: string): Promise<AgentApi | null> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${id}`, {
    headers: getHeaders(),
    cache: 'no-store',
    credentials: 'include',
  });
  handleUnauthorized(res);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(res.status === 400 ? text || 'Bad request' : `Failed to load agent: ${res.status}`);
  }
  return res.json();
}

/** Payload for create/update: camelCase, same shape as CreateAgentDto. */
export interface CreateAgentPayload {
  clientId?: string;
  storeId?: string;
  useWorkspaceDefaults?: boolean;
  agentName: string;
  storeName: string;
  storeUrl?: string;
  storeEmail?: string;
  supportEmail?: string;
  supportPhone?: string;
  businessName?: string;
  agentStatus?: 'draft' | 'active' | 'paused';
  language?: string;
  timezone?: string;
  voiceProvider?: string;
  voiceId?: string;
  elevenlabsModel?: string;
  voiceStyle?: string;
  languageMode?: 'auto' | 'fixed';
  fixedLanguage?: string;
  supportedLanguages?: string[];
  greetingMessage?: string;
  fallbackMessage?: string;
  shopifyStoreUrl?: string;
  shopifyStoreNumber?: string;
  shopifyAdminToken?: string;
  shopifyApiKey?: string;
  shopifyApiSecret?: string;
  webhookSecret?: string;
  databaseProvider?: string;
  databaseUrl?: string;
  databaseAccessToken?: string;
  knowledgeBaseSource?: string;
  knowledgeSyncEnabled?: boolean;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  callRoutingMode?: string;
  incomingCallHandling?: string;
  promptTemplate?: string; // form-only; not sent to API
  systemPrompt?: string;
  agentGoal?: string;
  agentRole?: string;
  toneOfVoice?: string;
  allowedActions?: string;
  restrictedActions?: string;
  escalationInstructions?: string;
  forbiddenBehaviors?: string;
  escalationRules?: string[] | string;
  askEmailBeforePaymentLink?: boolean;
  checkoutMode?: 'cart' | 'draft_order' | 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
  humanHandoffRules?: string;
  shippingPolicy?: string;
  returnPolicy?: string;
  exchangePolicy?: string;
  deliveryNotes?: string;
  returnRefundBehavior?: string;
  orderStatusHandling?: string;
  outOfStockHandling?: string;
  transferToHumanEnabled?: boolean;
  escalationPhone?: string;
  escalationEmail?: string;
}

export async function createAgent(payload: CreateAgentPayload): Promise<AgentApi> {
  const res = await fetch(`${getBaseUrl()}/api/agents`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message || `Create failed: ${res.status}`);
  }
  return res.json();
}

export async function updateAgent(
  id: string,
  payload: Partial<CreateAgentPayload>,
): Promise<AgentApi & { updatedSecrets?: UpdatedSecretsMeta }> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiErrorMessage(text, res.status));
  }
  return res.json();
}

/** Normalize Twilio numbers in the browser the same way as the API (NANP 10-digit → +1…). */
export { normalizePhoneNumber };

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(res.status === 400 ? text || 'Bad request' : `Delete failed: ${res.status}`);
  }
}

export type ConnectionTestTarget = 'shopify' | 'database' | 'twilio' | 'openai' | 'elevenlabs';

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  provider?: 'shopify' | 'database' | 'twilio' | 'openai' | 'elevenlabs';
  source?: 'agent' | 'workspace' | 'env' | 'missing';
  status?: string;
  shop?: { name?: string; domain?: string; email?: string };
  code?: string;
  warnings?: string[];
}

/** Test connection for an existing agent (uses stored credentials; optional body to override). Persists status on agent. */
export async function testAgentConnection(
  agentId: string,
  target: ConnectionTestTarget,
  credentials?: Partial<CreateAgentPayload>,
): Promise<ConnectionTestResult> {
  const path =
    target === 'shopify'
      ? 'test-shopify'
      : target === 'database'
        ? 'test-database'
        : target === 'twilio'
          ? 'test-twilio'
          : target === 'openai'
            ? 'test-openai'
            : 'test-elevenlabs';
  const body: Record<string, string | boolean | undefined> = {};
  if (target === 'shopify') {
    if (credentials?.shopifyStoreUrl) body.shopifyStoreUrl = credentials.shopifyStoreUrl;
    if (credentials?.shopifyAdminToken) body.shopifyAdminToken = credentials.shopifyAdminToken;
  } else if (target === 'database') {
    if (credentials?.databaseUrl) body.databaseUrl = credentials.databaseUrl;
    if (credentials?.databaseAccessToken) body.databaseAccessToken = credentials.databaseAccessToken;
    if (credentials?.databaseProvider) body.databaseProvider = credentials.databaseProvider;
  } else if (target === 'twilio') {
    if (credentials?.twilioAccountSid) body.twilioAccountSid = credentials.twilioAccountSid;
    if (credentials?.twilioAuthToken) body.twilioAuthToken = credentials.twilioAuthToken;
    if (credentials?.twilioPhoneNumber) body.twilioPhoneNumber = credentials.twilioPhoneNumber;
  } else if (target === 'openai') {
    if (credentials?.openaiApiKey) body.openaiApiKey = credentials.openaiApiKey;
  } else if (target === 'elevenlabs') {
    if (credentials?.elevenlabsApiKey) body.elevenlabsApiKey = credentials.elevenlabsApiKey;
    if (credentials?.voiceId) body.voiceId = credentials.voiceId;
  }
  if (credentials?.useWorkspaceDefaults === true) body.useWorkspaceDefaults = true;
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { message?: string }).message || res.statusText || 'Test failed';
    throw new Error(msg);
  }
  return data as ConnectionTestResult;
}

const DEBUG_SHOPIFY_TEST =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_DEBUG_AGENTS === 'true') ||
  (typeof window !== 'undefined' && (window as unknown as { __DEBUG_AGENTS?: boolean }).__DEBUG_AGENTS);

/** Test credentials without an agent (e.g. create flow). Does not persist. */
export async function testCredentials(
  target: ConnectionTestTarget,
  credentials: Partial<CreateAgentPayload>,
): Promise<ConnectionTestResult> {
  const path =
    target === 'shopify'
      ? 'test-credentials/shopify'
      : target === 'database'
        ? 'test-credentials/database'
        : target === 'twilio'
          ? 'test-credentials/twilio'
          : target === 'openai'
            ? 'test-credentials/openai'
            : 'test-credentials/elevenlabs';
  const body: Record<string, string | boolean | undefined> = {};
  if (target === 'shopify') {
    body.shopifyStoreUrl = credentials.shopifyStoreUrl?.trim() || undefined;
    body.shopifyAdminToken = credentials.shopifyAdminToken?.trim() || undefined;
  } else if (target === 'database') {
    body.databaseUrl = credentials.databaseUrl?.trim() || undefined;
    body.databaseAccessToken = credentials.databaseAccessToken?.trim() || undefined;
    body.databaseProvider = credentials.databaseProvider?.trim() || undefined;
  } else if (target === 'twilio') {
    body.twilioAccountSid = credentials.twilioAccountSid?.trim() || undefined;
    body.twilioAuthToken = credentials.twilioAuthToken?.trim() || undefined;
    body.twilioPhoneNumber = credentials.twilioPhoneNumber?.trim() || undefined;
  } else if (target === 'openai') {
    body.openaiApiKey = credentials.openaiApiKey?.trim() || undefined;
  } else if (target === 'elevenlabs') {
    body.elevenlabsApiKey = credentials.elevenlabsApiKey?.trim() || undefined;
    body.voiceId = credentials.voiceId?.trim() || undefined;
  }
  body.useWorkspaceDefaults = credentials.useWorkspaceDefaults === true ? true : undefined;
  const url = `${getBaseUrl() || ''}/api/agents/${path}`;
  const bodyStr = JSON.stringify(body);
  if (DEBUG_SHOPIFY_TEST && target === 'shopify') {
    const mask = (s: string | undefined) => (s && s.length > 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : '***');
    const urlMask = typeof body.shopifyStoreUrl === 'string' ? mask(body.shopifyStoreUrl) : 'empty';
    const tokenMask = typeof body.shopifyAdminToken === 'string' ? mask(body.shopifyAdminToken) : 'empty';
    console.debug('[ShopifyTest:client] POST', url, 'payloadKeys:', Object.keys(body), 'urlMask:', urlMask, 'tokenMask:', tokenMask);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: bodyStr,
      credentials: 'include',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    if (DEBUG_SHOPIFY_TEST && target === 'shopify') console.debug('[ShopifyTest:client] fetch threw', msg);
    throw new Error(msg.includes('fetch') || msg.includes('Failed') ? 'Backend unavailable. Is the API running?' : msg);
  }
  const raw = await res.text();
  let data: { success?: boolean; message?: string | string[]; code?: string; shop?: unknown; warnings?: unknown };
  try {
    data = raw ? (JSON.parse(raw) as typeof data) : {};
  } catch {
    if (DEBUG_SHOPIFY_TEST && target === 'shopify') console.debug('[ShopifyTest:client] response not JSON', res.status, raw.slice(0, 80));
    data = { success: false, message: raw && raw.length < 300 ? raw : `Request failed (${res.status}).` };
  }
  const msgVal = data.message;
  const messageStr = typeof msgVal === 'string' ? msgVal : Array.isArray(msgVal) && msgVal.length > 0 && typeof msgVal[0] === 'string' ? msgVal[0] : '';
  if (!res.ok) {
    const msg =
      messageStr ||
      (res.status === 502 ? 'Backend unavailable. Is the API running?' : res.statusText || 'Connection test failed.');
    if (DEBUG_SHOPIFY_TEST && target === 'shopify') console.debug('[ShopifyTest:client] FAIL', res.status, msg);
    throw new Error(msg);
  }
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter((w): w is string => typeof w === 'string')
    : undefined;
  return {
    ...data,
    message: messageStr || (typeof data.message === 'string' ? data.message : 'Connection test completed.'),
    warnings,
  } as ConnectionTestResult;
}

export async function getAgentAnalytics(agentId: string): Promise<{
  totalCalls: number;
  resolvedCalls: number;
  escalatedCalls: number;
  avgDurationSeconds: number | null;
  lastCallAt: string | null;
}> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/analytics`, {
    headers: getHeaders(),
    cache: 'no-store',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function getAgentLogs(agentId: string, limit = 50): Promise<
  Array<{
    id: string;
    fromNumber: string | null;
    toNumber: string | null;
    status: string;
    escalated: boolean;
    durationSeconds: number | null;
    createdAt: string;
    endedAt: string | null;
  }>
> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/logs?limit=${limit}`, {
    headers: getHeaders(),
    cache: 'no-store',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function getAgentCatalogReadiness(agentId: string): Promise<{
  catalogReady: boolean;
  lastSyncedAt: string | null;
  itemCount: number;
  reason: string;
}> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/catalog-readiness`, {
    headers: getHeaders(),
    cache: 'no-store',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function testAgentAi(
  agentId: string,
  sampleQuery?: string,
): Promise<{ success: boolean; message: string; suggestedResponse?: string }> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/test-ai`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ sampleQuery: sampleQuery ?? 'Where is my order?' }),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function getAgentReadiness(agentId: string): Promise<AgentReadinessResponse> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/readiness`, {
    headers: getHeaders(),
    cache: 'no-store',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function configureTwilioWebhook(agentId: string): Promise<AgentReadinessResponse> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/configure-twilio-webhook`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function syncAgentSecretsFromSettings(
  agentId: string,
): Promise<AgentApi & { updatedSecrets?: UpdatedSecretsMeta }> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/sync-secrets-from-settings`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function runAgentSmokeTest(agentId: string): Promise<{
  ok: boolean;
  checks: Array<{ key: string; pass: boolean; details: string }>;
  note?: string;
}> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/smoke-test`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify({ dryRun: true }),
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function goLiveAgent(agentId: string): Promise<{
  status: 'LIVE' | 'CONFIG_REQUIRED';
  ready: boolean;
  failures?: Array<{ key: string; label: string; fixAction: string }>;
  readiness: AgentReadinessResponse;
}> {
  const res = await fetch(`${getBaseUrl()}/api/agents/${agentId}/go-live`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

export async function simulateAgentBuyingFlow(
  agentId: string,
  input?: {
    query?: string;
    customerEmail?: string;
    sendEmail?: boolean;
    checkoutMode?: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
  },
): Promise<{ ok: boolean; reason?: string; callSessionId?: string; emailSent?: boolean; steps?: unknown[] }> {
  const res = await fetch(`${getBaseUrl()}/api/ops/agents/${agentId}/simulate-buying-flow`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify(input ?? {}),
  });
  if (!res.ok) throw new Error(await parseErrorResponse(res));
  return res.json();
}

/** Map API agent to form data for edit. Secrets are never returned, so those fields stay empty. */
export function agentToFormData(a: AgentApi): CreateAgentPayload {
  const cfg = a.agentConfig ?? null;
  const voiceCfg = a.voiceProfile?.providerConfig ?? null;
  const status = mapStatus(a.status);
  const checkoutModeRaw =
    (a.checkoutMode as string | undefined) ??
    cfg?.checkoutMode ??
    'STOREFRONT_CART';
  const checkoutMode = toCheckoutModeForm(checkoutModeRaw);
  return {
    clientId: (a.clientId as string) ?? '',
    storeId: (a.storeId as string) ?? '',
    useWorkspaceDefaults: false,
    agentName: a.name ?? '',
    storeName: (a.storeName as string) ?? '',
    storeUrl: (a.storeUrl as string) ?? '',
    storeEmail: (a.storeEmail as string) ?? '',
    supportEmail: (a.supportEmail as string) ?? cfg?.supportEmail ?? '',
    supportPhone: (a.supportPhone as string) ?? cfg?.supportPhone ?? '',
    businessName: (a.businessName as string) ?? cfg?.businessName ?? '',
    databaseAccessToken: '',
    databaseUrl: (a.databaseUrl as string) ?? '',
    agentStatus: status,
    language: (a.language as string) ?? 'en',
    timezone: (a.timezone as string) ?? 'UTC',
    voiceProvider: (a.voiceProvider as string) ?? '',
    voiceId: (a.voiceId as string) ?? '',
    elevenlabsModel: voiceCfg?.elevenlabsModel ?? 'eleven_multilingual_v2',
    voiceStyle: (a.voiceStyle as string) ?? voiceCfg?.voiceStyle ?? 'natural, warm, professional, slightly slow, human-like',
    languageMode: voiceCfg?.languageMode ?? 'auto',
    fixedLanguage: voiceCfg?.fixedLanguage ?? 'en',
    supportedLanguages:
      Array.isArray(voiceCfg?.supportedLanguages) && voiceCfg?.supportedLanguages.length > 0
        ? voiceCfg.supportedLanguages
        : ['en', 'ur', 'hi', 'ar', 'es', 'fr', 'de'],
    openaiApiKey: '',
    elevenlabsApiKey: '',
    greetingMessage: (a.greetingMessage as string) ?? '',
    fallbackMessage: (a.fallbackMessage as string) ?? '',
    shopifyStoreUrl: (a.shopifyStoreUrl as string) ?? '',
    shopifyStoreNumber: (a.shopifyStoreNumber as string) ?? '',
    shopifyAdminToken: '',
    shopifyApiKey: '',
    shopifyApiSecret: '',
    webhookSecret: '',
    knowledgeBaseSource: (a.knowledgeBaseSource as string) ?? '',
    knowledgeSyncEnabled: (a.knowledgeSyncEnabled as boolean) ?? true,
    twilioPhoneNumber: (a.twilioPhoneNumber as string) ?? '',
    twilioAccountSid: '',
    twilioAuthToken: '',
    callRoutingMode: (a.callRoutingMode as string) ?? 'auto',
    incomingCallHandling: (a.incomingCallHandling as string) ?? 'answer',
    databaseProvider: (a.databaseProvider as string) ?? '',
    promptTemplate: '',
    systemPrompt:
      (a.customSystemPrompt as string) ||
      (a.baseSystemPrompt as string) ||
      '',
    agentGoal: (a.agentGoal as string) ?? '',
    agentRole: (a.agentRole as string) ?? '',
    toneOfVoice: (a.toneOfVoice as string) ?? '',
    allowedActions: (a.allowedActions as string) ?? '',
    restrictedActions: (a.restrictedActions as string) ?? '',
    escalationInstructions: (a.escalationInstructions as string) ?? '',
    forbiddenBehaviors: (a.forbiddenBehaviors as string) ?? cfg?.forbiddenBehaviors ?? '',
    escalationRules: (a.escalationRules as string) ?? cfg?.escalationRules ?? '',
    askEmailBeforePaymentLink: (a.askEmailBeforePaymentLink as boolean) ?? cfg?.askEmailBeforePaymentLink ?? true,
    checkoutMode,
    humanHandoffRules: (a.humanHandoffRules as string) ?? cfg?.humanHandoffRules ?? '',
    shippingPolicy: (a.shippingPolicy as string) ?? cfg?.shippingPolicy ?? '',
    returnPolicy: (a.returnPolicy as string) ?? cfg?.returnPolicy ?? '',
    exchangePolicy: (a.exchangePolicy as string) ?? cfg?.exchangePolicy ?? '',
    deliveryNotes: (a.deliveryNotes as string) ?? cfg?.deliveryNotes ?? '',
    returnRefundBehavior: (a.returnRefundBehavior as string) ?? '',
    orderStatusHandling: (a.orderStatusHandling as string) ?? '',
    outOfStockHandling: (a.outOfStockHandling as string) ?? '',
    transferToHumanEnabled: (a.transferToHumanEnabled as boolean) ?? true,
    escalationPhone: (a.escalationPhone as string) ?? '',
    escalationEmail: (a.escalationEmail as string) ?? '',
  };
}
