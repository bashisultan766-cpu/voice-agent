/**
 * Agents API client. Browser calls same-origin `/api/agents` (Next route forwards cookie → JWT).
 * For Server Components use `getAgentServer` from `@/lib/api/agents-server`.
 */
import {
  toCheckoutModeForm,
  normalizePhoneNumber,
  DEFAULT_TOOL_PERMISSIONS,
  DEFAULT_VOICE_PERSONALITY,
  type AgentToolPermissions,
  type VoicePersonalityTraits,
} from '@bookstore-voice-agents/types';
import { parseApiErrorMessage } from '@/lib/api/error-message';
import {
  authenticatedFetch,
  authenticatedFetchJson,
  getAuthenticatedHeaders,
} from '@/lib/api/authenticated-fetch';

const getBaseUrl = () =>
  typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

function getHeaders(): HeadersInit {
  return getAuthenticatedHeaders();
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
    personality?: VoicePersonalityTraits | null;
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
    | 'elevenlabsApiKey'
    | 'resendApiKey',
    boolean
  >
>;

export interface AgentReadinessCheck {
  key: string;
  label: string;
  pass: boolean;
  fixAction: string;
}

export type CredentialSourceApi = 'agent' | 'workspace' | 'env' | 'missing';

export interface CredentialSourcesSummaryApi {
  shopify: {
    configured: boolean;
    source: CredentialSourceApi;
    useWorkspaceShopify: boolean;
    shopifyStoreUrlPresent: boolean;
  };
  openai: { source: CredentialSourceApi; configured: boolean; useWorkspaceOpenai: boolean };
  elevenlabs: { source: CredentialSourceApi; configured: boolean; useWorkspaceElevenlabs: boolean };
  twilio: { authSource: CredentialSourceApi; configured: boolean; useWorkspaceTwilio: boolean };
  resend: { source: CredentialSourceApi; configured: boolean; useWorkspaceEmail: boolean };
}

export interface AgentReadinessResponse {
  ready: boolean;
  status: 'READY' | 'CONFIG_REQUIRED';
  checks: AgentReadinessCheck[];
  failures: Array<{ key: string; label: string; fixAction: string }>;
  credentialSources?: CredentialSourcesSummaryApi;
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

export async function getAgents(): Promise<AgentListItem[]> {
  const data = (await authenticatedFetchJson<unknown>(`${getBaseUrl()}/api/agents`, {
    cache: 'no-store',
  })) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('Invalid agents response from server.');
  }
  return agentApisToListItems(data as AgentApi[]);
}

export async function getAgent(id: string): Promise<AgentApi | null> {
  const res = await authenticatedFetch(`${getBaseUrl()}/api/agents/${id}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiErrorMessage(text, res.status));
  }
  return res.json() as Promise<AgentApi>;
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
  openAiModel?: string;
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
  voiceNameLabel?: string;
  emailSenderName?: string;
  emailSenderAddress?: string;
  emailReplyTo?: string;
  emailSubjectTemplate?: string;
  paymentLinkEmailIntro?: string;
  emailTestRecipient?: string;
  useWorkspaceEmail?: boolean;
  useWorkspaceShopify?: boolean;
  useWorkspaceOpenai?: boolean;
  useWorkspaceElevenlabs?: boolean;
  useWorkspaceTwilio?: boolean;
  shopifyApiVersion?: string;
  resendApiKey?: string;
  toolPermissions?: AgentToolPermissions;
  voicePersonality?: VoicePersonalityTraits;
  enabledTools?: string[];
}

export async function createAgent(payload: CreateAgentPayload): Promise<AgentApi> {
  return authenticatedFetchJson<AgentApi>(`${getBaseUrl()}/api/agents`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateAgent(
  id: string,
  payload: Partial<CreateAgentPayload>,
): Promise<AgentApi & { updatedSecrets?: UpdatedSecretsMeta }> {
  return authenticatedFetchJson<AgentApi & { updatedSecrets?: UpdatedSecretsMeta }>(
    `${getBaseUrl()}/api/agents/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  );
}

export type PatchAgentCredentialsPayload = {
  useWorkspaceShopify?: boolean;
  shopifyStoreUrl?: string;
  shopifyAdminToken?: string;
  shopifyApiVersion?: string;
  useWorkspaceTwilio?: boolean;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  useWorkspaceOpenai?: boolean;
  openaiApiKey?: string;
  useWorkspaceElevenlabs?: boolean;
  elevenlabsApiKey?: string;
  voiceId?: string;
  useWorkspaceEmail?: boolean;
  resendApiKey?: string;
  emailSenderName?: string;
  emailSenderAddress?: string;
  emailReplyTo?: string;
  emailSubjectTemplate?: string;
  paymentLinkEmailIntro?: string;
  clearOpenaiApiKey?: boolean;
  clearElevenlabsApiKey?: boolean;
  clearResendApiKey?: boolean;
};

export async function patchAgentCredentials(
  agentId: string,
  payload: PatchAgentCredentialsPayload,
): Promise<
  AgentApi & {
    updatedSecrets?: UpdatedSecretsMeta;
    readiness: AgentReadinessResponse;
    credentialSources: CredentialSourcesSummaryApi;
  }
> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/credentials`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/** Normalize Twilio numbers in the browser the same way as the API (NANP 10-digit → +1…). */
export { normalizePhoneNumber };

export async function deleteAgent(id: string): Promise<void> {
  const res = await authenticatedFetch(`${getBaseUrl()}/api/agents/${id}`, {
    method: 'DELETE',
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
  const res = await authenticatedFetch(`${getBaseUrl()}/api/agents/${agentId}/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
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
    res = await authenticatedFetch(url, {
      method: 'POST',
      body: bodyStr,
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
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/analytics`, {
    cache: 'no-store',
  });
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
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/logs?limit=${limit}`, {
    cache: 'no-store',
  });
}

export async function getAgentCatalogReadiness(agentId: string): Promise<{
  catalogReady: boolean;
  lastSyncedAt: string | null;
  itemCount: number;
  reason: string;
}> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/catalog-readiness`, {
    cache: 'no-store',
  });
}

export async function testAgentAi(
  agentId: string,
  sampleQuery?: string,
): Promise<{ success: boolean; message: string; suggestedResponse?: string }> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/test-ai`, {
    method: 'POST',
    body: JSON.stringify({ sampleQuery: sampleQuery ?? 'Where is my order?' }),
  });
}

export interface RuntimePromptPreview {
  agentId: string;
  agentName: string;
  updatedAt: string;
  greetingMessage: string | null;
  prompt: string;
  promptLength: number;
  promptBudget?: {
    estimatedTokens: number;
    status: string;
    warnings: string[];
    recommendKnowledgeBase: boolean;
  };
  promptLayers?: Record<string, string>;
}

export async function getAgentRuntimePromptPreview(agentId: string): Promise<RuntimePromptPreview> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/runtime-prompt-preview`, {
    cache: 'no-store',
  });
}

export async function sendAgentTestEmail(
  agentId: string,
  input?: { toEmail?: string; checkoutUrl?: string },
): Promise<{ success: boolean; message: string; emailEventId?: string }> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/test-email`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  });
}

export async function getAgentReadiness(agentId: string): Promise<AgentReadinessResponse> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/readiness`, {
    cache: 'no-store',
  });
}

export async function configureTwilioWebhook(agentId: string): Promise<AgentReadinessResponse> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/configure-twilio-webhook`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function syncAgentSecretsFromSettings(
  agentId: string,
): Promise<AgentApi & { updatedSecrets?: UpdatedSecretsMeta }> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/sync-secrets-from-settings`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function runAgentSmokeTest(agentId: string): Promise<{
  ok: boolean;
  checks: Array<{ key: string; pass: boolean; details: string }>;
  note?: string;
}> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/smoke-test`, {
    method: 'POST',
    body: JSON.stringify({ dryRun: true }),
  });
}

export async function goLiveAgent(agentId: string): Promise<{
  status: 'LIVE' | 'CONFIG_REQUIRED';
  ready: boolean;
  failures?: Array<{ key: string; label: string; fixAction: string }>;
  readiness: AgentReadinessResponse;
}> {
  return authenticatedFetchJson(`${getBaseUrl()}/api/agents/${agentId}/go-live`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export type AgentStatusTransition = 'draft' | 'active' | 'paused';

export interface UpdateAgentStatusResponse {
  agent: AgentApi;
  ready?: boolean;
  goLiveStatus?: 'LIVE' | 'CONFIG_REQUIRED';
  failures?: Array<{ key: string; label: string; fixAction: string }>;
  readiness?: AgentReadinessResponse;
}

/** List/dashboard status control — activate runs readiness checks (go-live). */
export async function updateAgentStatus(
  agentId: string,
  status: AgentStatusTransition,
): Promise<UpdateAgentStatusResponse> {
  return authenticatedFetchJson<UpdateAgentStatusResponse>(`${getBaseUrl()}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

const READINESS_FIX_HINTS: Record<string, string> = {
  openai_connected: 'Settings → Integrations → OpenAI, or agent OpenAI key on the edit form.',
  elevenlabs_connected: 'Settings → Integrations → ElevenLabs, or agent ElevenLabs key + voice ID.',
  email_connected: 'Settings → Integrations → Email (Resend), or agent email sender + Resend key.',
  resend_key_configured: 'Settings → Integrations → Email (Resend API key).',
  email_sender_configured: 'Agent email sender fields or Settings → Integrations → Email.',
  shopify_connected: 'Agent Shopify tab, or Settings → Integrations → Shopify with “use workspace”.',
  twilio_credentials_configured: 'Settings → Integrations → Twilio, or agent Twilio credentials.',
  twilio_webhook_verified: 'Agent details → Configure Twilio Webhook.',
  catalog_ready: 'Agent details → sync Shopify catalog / products.',
};

export function formatAgentStatusFailureMessage(
  failures?: Array<{ key?: string; label: string; fixAction: string }>,
): string {
  if (!failures?.length) {
    return 'Agent is not ready to go live. Open the agent and complete readiness checks.';
  }
  return failures
    .map((f) => {
      const where = f.key ? READINESS_FIX_HINTS[f.key] : undefined;
      return where ? `${f.label}: ${f.fixAction} (${where})` : `${f.label}: ${f.fixAction}`;
    })
    .join(' · ');
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
  return authenticatedFetchJson(`${getBaseUrl()}/api/ops/agents/${agentId}/simulate-buying-flow`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  });
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
    useWorkspaceShopify: (a.useWorkspaceShopify as boolean) ?? false,
    shopifyApiVersion: (a.shopifyApiVersion as string) ?? '2024-10',
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
    openAiModel: (a.model as string) ?? 'gpt-4o-mini',
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
    voiceNameLabel: (a.voiceNameLabel as string) ?? '',
    emailSenderName: (a.emailSenderName as string) ?? '',
    emailSenderAddress: (a.emailSenderAddress as string) ?? '',
    emailReplyTo: (a.emailReplyTo as string) ?? '',
    emailSubjectTemplate:
      (a.emailSubjectTemplate as string) ?? '{{storeName}} — Complete your secure checkout',
    paymentLinkEmailIntro: (a.paymentLinkEmailIntro as string) ?? '',
    emailTestRecipient: (a.emailTestRecipient as string) ?? '',
    useWorkspaceEmail: (a.useWorkspaceEmail as boolean) ?? false,
    useWorkspaceOpenai: (a.useWorkspaceOpenai as boolean) ?? false,
    useWorkspaceElevenlabs: (a.useWorkspaceElevenlabs as boolean) ?? false,
    useWorkspaceTwilio: (a.useWorkspaceTwilio as boolean) ?? false,
    resendApiKey: '',
    toolPermissions: {
      ...DEFAULT_TOOL_PERMISSIONS,
      ...((a.toolPermissions as Record<string, boolean> | undefined) ?? {}),
    },
    voicePersonality: {
      ...DEFAULT_VOICE_PERSONALITY,
      ...(((a.voiceProfile?.providerConfig as { personality?: VoicePersonalityTraits } | null)?.personality ??
        a.voiceProfile?.personality ??
        {}) as VoicePersonalityTraits),
    },
  };
}
