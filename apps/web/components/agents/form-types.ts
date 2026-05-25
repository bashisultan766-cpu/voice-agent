export type AgentStatus = 'draft' | 'active' | 'paused';

/** Field limits aligned with Nest `CreateAgentDto` where applicable. */
export const AGENT_FIELD_LIMITS = {
  greetingMessage: 2000,
  fallbackMessage: 2000,
  systemPrompt: 10000,
  agentRole: 300,
  agentGoal: 500,
  allowedActions: 2000,
  restrictedActions: 2000,
  escalationInstructions: 2000,
  returnRefundBehavior: 2000,
  orderStatusHandling: 2000,
  outOfStockHandling: 2000,
  humanHandoffRules: 2000,
  policyText: 4000,
  forbiddenBehaviors: 4000,
} as const;

export interface CreateAgentFormData {
  clientId: string;
  storeId: string;
  /** When true, the API fills empty Shopify/Twilio/OpenAI fields from encrypted workspace settings before validation. */
  useWorkspaceDefaults: boolean;
  // 1. Store Information
  storeName: string;
  storeUrl: string;
  storeEmail: string;
  supportPhone: string;
  supportEmail: string;
  /** Not shown in UI; kept for API/edit compatibility. */
  databaseAccessToken: string;
  // 2. Voice Configuration
  agentName: string;
  agentStatus: AgentStatus;
  language: string;
  timezone: string;

  voiceProvider: string;
  voiceId: string;
  elevenlabsModel: string;
  voiceStyle: string;
  languageMode: 'auto' | 'fixed';
  fixedLanguage: string;
  supportedLanguages: string[];
  openaiApiKey: string;
  elevenlabsApiKey: string;
  greetingMessage: string;
  fallbackMessage: string;

  // 3. Shopify Integration
  shopifyStoreUrl: string;
  shopifyStoreNumber: string;
  shopifyAdminToken: string;
  shopifyApiKey: string;
  shopifyApiSecret: string;
  webhookSecret: string;

  // 4. Knowledge (optional). DB URL/provider not exposed to tenants — API-only.
  databaseProvider: string;
  databaseUrl: string;
  knowledgeBaseSource: string;
  knowledgeSyncEnabled: boolean;

  // 5. Twilio Setup
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  callRoutingMode: string;
  incomingCallHandling: string;

  // 6. AI System Prompt
  openAiModel: string;
  promptTemplate: string;
  systemPrompt: string;
  agentRole: string;
  toneOfVoice: string;
  agentGoal: string;
  allowedActions: string;
  restrictedActions: string;
  escalationInstructions: string;
  forbiddenBehaviors: string;
  escalationRules: string;
  askEmailBeforePaymentLink: boolean;
  checkoutMode: 'cart' | 'draft_order';
  humanHandoffRules: string;
  shippingPolicy: string;
  returnPolicy: string;
  exchangePolicy: string;
  deliveryNotes: string;

  // 7. Customer Interaction Handling
  returnRefundBehavior: string;
  orderStatusHandling: string;
  outOfStockHandling: string;
  transferToHumanEnabled: boolean;
  escalationPhone: string;
  escalationEmail: string;
}

export const initialFormData: CreateAgentFormData = {
  clientId: '',
  storeId: '',
  useWorkspaceDefaults: true,
  storeName: '',
  storeUrl: '',
  storeEmail: '',
  supportPhone: '',
  supportEmail: '',
  databaseAccessToken: '',
  agentName: '',
  agentStatus: 'draft',
  language: 'en',
  timezone: 'UTC',
  voiceProvider: 'elevenlabs',
  voiceId: '',
  elevenlabsModel: 'eleven_multilingual_v2',
  voiceStyle: 'natural, warm, professional, slightly slow, human-like',
  languageMode: 'auto',
  fixedLanguage: 'en',
  supportedLanguages: ['en', 'ur', 'hi', 'ar', 'es', 'fr', 'de'],
  openaiApiKey: '',
  elevenlabsApiKey: '',
  greetingMessage: '',
  fallbackMessage: '',
  shopifyStoreUrl: '',
  shopifyStoreNumber: '',
  shopifyAdminToken: '',
  shopifyApiKey: '',
  shopifyApiSecret: '',
  webhookSecret: '',
  databaseProvider: '',
  databaseUrl: '',
  knowledgeBaseSource: '',
  knowledgeSyncEnabled: true,
  twilioAccountSid: '',
  twilioAuthToken: '',
  twilioPhoneNumber: '',
  callRoutingMode: 'auto',
  incomingCallHandling: 'answer',
  openAiModel: 'gpt-4o-mini',
  promptTemplate: '',
  systemPrompt: '',
  agentRole: '',
  toneOfVoice: '',
  agentGoal: '',
  allowedActions: '',
  restrictedActions: '',
  escalationInstructions: '',
  forbiddenBehaviors: '',
  escalationRules: '',
  askEmailBeforePaymentLink: true,
  checkoutMode: 'cart',
  humanHandoffRules: '',
  shippingPolicy: '',
  returnPolicy: '',
  exchangePolicy: '',
  deliveryNotes: '',
  returnRefundBehavior: '',
  orderStatusHandling: '',
  outOfStockHandling: '',
  transferToHumanEnabled: true,
  escalationPhone: '',
  escalationEmail: '',
};

export interface FormErrors {
  [key: string]: string | undefined;
}

const urlPattern = /^https?:\/\/.+/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9()\-\s]{7,20}$/;

/** Returns hostname if input is parseable as URL (adds https:// if no protocol); null if invalid. */
export function getHostnameFromShopifyInput(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const withProtocol = s.match(/^https?:\/\//i) ? s : `https://${s}`;
  try {
    return new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True if hostname is a Shopify admin domain (*.myshopify.com). */
export function isMyshopifyDomain(hostname: string): boolean {
  return hostname === 'myshopify.com' || hostname.endsWith('.myshopify.com');
}

function maxLen(field: keyof typeof AGENT_FIELD_LIMITS, label: string, len: number): string {
  return `${label} must be ${len} characters or fewer (matches server limit).`;
}

function validateShopifyDomain(data: CreateAgentFormData, e: FormErrors) {
  const shopifyHost = data.shopifyStoreUrl?.trim() ? getHostnameFromShopifyInput(data.shopifyStoreUrl.trim()) : null;
  if (data.shopifyStoreUrl?.trim()) {
    if (!shopifyHost) {
      e.shopifyStoreUrl =
        'Enter a valid Shopify admin domain (for example your-store.myshopify.com).';
    } else if (!isMyshopifyDomain(shopifyHost)) {
      e.shopifyStoreUrl =
        'Use the myshopify.com domain from Shopify Admin (Settings → Domains), not your public storefront URL.';
    }
  }
}

function validateApiKeyLengths(data: CreateAgentFormData, e: FormErrors) {
  if (data.openaiApiKey?.trim() && data.openaiApiKey.trim().length < 20) {
    e.openaiApiKey = 'This OpenAI key looks too short. Check you pasted the full secret key.';
  }
  if (data.elevenlabsApiKey?.trim() && data.elevenlabsApiKey.trim().length < 10) {
    e.elevenlabsApiKey = 'This ElevenLabs key looks too short. Check you pasted the full API key.';
  }
}

/** Full validation before “Create agent” (live) submit — mirrors server rules. */
export function validateCreateAgentForm(
  data: CreateAgentFormData,
  stores: readonly { id: string }[] = [],
): FormErrors {
  const e: FormErrors = {};

  if (!data.storeId?.trim()) {
    e.storeId =
      stores.length === 0
        ? 'Connect a Shopify store under Settings → Integrations → Shopify before launching.'
        : 'Select a store.';
  } else if (stores.length > 0 && !stores.some((s) => s.id === data.storeId)) {
    e.storeId = 'Selected store is not valid for this workspace. Pick a store from the list.';
  }
  if (!data.agentName?.trim()) e.agentName = 'Give your voice agent a short name so you can find it later.';
  if (!data.storeName?.trim()) e.storeName = 'Store name is required. This is how your business appears in the dashboard.';

  if (data.storeUrl?.trim() && !urlPattern.test(data.storeUrl.trim())) {
    e.storeUrl = 'Enter a full URL starting with https:// (for example https://yourbrand.com).';
  }
  if (data.storeEmail?.trim() && !emailPattern.test(data.storeEmail.trim())) {
    e.storeEmail = 'Enter a valid store email address.';
  }
  if (data.supportEmail?.trim() && !emailPattern.test(data.supportEmail.trim())) {
    e.supportEmail = 'Enter a valid support email address.';
  }
  if (data.supportPhone?.trim() && !phonePattern.test(data.supportPhone.trim())) {
    e.supportPhone = 'Enter a valid support phone number (digits, spaces, +, -, parentheses).';
  }

  if (data.greetingMessage?.length > AGENT_FIELD_LIMITS.greetingMessage) {
    e.greetingMessage = maxLen('greetingMessage', 'Greeting', AGENT_FIELD_LIMITS.greetingMessage);
  }
  if (data.fallbackMessage?.length > AGENT_FIELD_LIMITS.fallbackMessage) {
    e.fallbackMessage = maxLen('fallbackMessage', 'Fallback message', AGENT_FIELD_LIMITS.fallbackMessage);
  }

  validateShopifyDomain(data, e);

  if (data.escalationEmail?.trim() && !emailPattern.test(data.escalationEmail.trim())) {
    e.escalationEmail = 'Enter a valid escalation email or leave the field blank.';
  }
  if (data.escalationPhone?.trim() && !phonePattern.test(data.escalationPhone.trim())) {
    e.escalationPhone = 'Enter a valid escalation phone number or leave it blank.';
  }
  if (data.twilioPhoneNumber?.trim() && !phonePattern.test(data.twilioPhoneNumber.trim())) {
    e.twilioPhoneNumber = 'Enter a valid Twilio phone number (E.164 recommended).';
  }

  validateApiKeyLengths(data, e);

  const L = AGENT_FIELD_LIMITS;
  if (data.systemPrompt.length > L.systemPrompt) e.systemPrompt = maxLen('systemPrompt', 'Main instructions', L.systemPrompt);
  if (data.agentRole.length > L.agentRole) e.agentRole = maxLen('agentRole', 'Agent role', L.agentRole);
  if (data.agentGoal.length > L.agentGoal) e.agentGoal = maxLen('agentGoal', 'Goal', L.agentGoal);
  if (data.allowedActions.length > L.allowedActions) e.allowedActions = maxLen('allowedActions', 'Allowed actions', L.allowedActions);
  if (data.restrictedActions.length > L.restrictedActions) {
    e.restrictedActions = maxLen('restrictedActions', 'Forbidden actions', L.restrictedActions);
  }
  if (data.escalationInstructions.length > L.escalationInstructions) {
    e.escalationInstructions = maxLen('escalationInstructions', 'Escalation rule', L.escalationInstructions);
  }
  if (data.returnRefundBehavior.length > L.returnRefundBehavior) {
    e.returnRefundBehavior = maxLen('returnRefundBehavior', 'Returns & refunds', L.returnRefundBehavior);
  }
  if (data.orderStatusHandling.length > L.orderStatusHandling) {
    e.orderStatusHandling = maxLen('orderStatusHandling', 'Order tracking', L.orderStatusHandling);
  }
  if (data.outOfStockHandling.length > L.outOfStockHandling) {
    e.outOfStockHandling = maxLen('outOfStockHandling', 'Out of stock', L.outOfStockHandling);
  }
  if (data.humanHandoffRules.length > L.humanHandoffRules) {
    e.humanHandoffRules = maxLen('humanHandoffRules', 'Human handoff rules', L.humanHandoffRules);
  }
  if (data.forbiddenBehaviors.length > L.forbiddenBehaviors) {
    e.forbiddenBehaviors = maxLen('forbiddenBehaviors', 'Forbidden behaviors', L.forbiddenBehaviors);
  }
  for (const key of ['shippingPolicy', 'returnPolicy', 'exchangePolicy', 'deliveryNotes'] as const) {
    if (data[key].length > L.policyText) {
      e[key] = maxLen('policyText', 'This policy field', L.policyText);
    }
  }

  return e;
}

export type CreateAgentStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Map validation field keys to wizard step (for jumping to first error on save).
 * Order: Basic Info → Shopify → Voice → Sales → Policies → AI → Review.
 */
const FORM_FIELD_STEP: Partial<Record<string, CreateAgentStep>> = {
  storeName: 1,
  clientId: 1,
  storeId: 1,
  storeUrl: 1,
  storeEmail: 1,
  supportPhone: 1,
  supportEmail: 1,
  agentName: 1,
  agentStatus: 1,
  language: 1,
  timezone: 1,
  shopifyStoreUrl: 2,
  shopifyStoreNumber: 2,
  shopifyAdminToken: 2,
  shopifyApiKey: 2,
  shopifyApiSecret: 2,
  webhookSecret: 2,
  knowledgeBaseSource: 2,
  knowledgeSyncEnabled: 2,
  voiceProvider: 3,
  voiceId: 3,
  elevenlabsModel: 3,
  voiceStyle: 3,
  languageMode: 3,
  fixedLanguage: 3,
  supportedLanguages: 3,
  openaiApiKey: 3,
  elevenlabsApiKey: 3,
  greetingMessage: 3,
  fallbackMessage: 3,
  twilioAccountSid: 4,
  twilioAuthToken: 4,
  twilioPhoneNumber: 4,
  callRoutingMode: 4,
  incomingCallHandling: 4,
  askEmailBeforePaymentLink: 4,
  checkoutMode: 4,
  humanHandoffRules: 4,
  returnRefundBehavior: 4,
  orderStatusHandling: 4,
  outOfStockHandling: 4,
  transferToHumanEnabled: 4,
  escalationPhone: 4,
  escalationEmail: 4,
  shippingPolicy: 5,
  returnPolicy: 5,
  exchangePolicy: 5,
  deliveryNotes: 5,
  promptTemplate: 6,
  systemPrompt: 6,
  agentRole: 6,
  agentGoal: 6,
  toneOfVoice: 6,
  allowedActions: 6,
  restrictedActions: 6,
  escalationInstructions: 6,
  forbiddenBehaviors: 6,
  escalationRules: 6,
};

/** Lowest-numbered step that contains a field with a validation error. */
export function firstStepWithErrors(errors: FormErrors): CreateAgentStep | null {
  let best: CreateAgentStep | null = null;
  for (const key of Object.keys(errors)) {
    const s = FORM_FIELD_STEP[key];
    if (s !== undefined && (best === null || s < best)) best = s;
  }
  return best;
}

/** Wizard step (1–7) for a known form field key, or null if unmapped. */
export function stepForFormField(key: string): CreateAgentStep | null {
  const s = FORM_FIELD_STEP[key];
  return s !== undefined ? s : null;
}

const MSG_NO_STORE_CONNECTED =
  'No Shopify store connected yet. Go to Settings → Integrations → Shopify to connect your store.';

/** Step 1 — Basic info (store + agent identity). `stores` is the current workspace store list from the API. */
export function validateStepBasicInfo(
  data: CreateAgentFormData,
  stores: readonly { id: string }[] = [],
): FormErrors {
  const e: FormErrors = {};
  if (!data.clientId?.trim()) e.clientId = 'Select a client.';
  if (!data.storeId?.trim()) {
    e.storeId = stores.length === 0 ? MSG_NO_STORE_CONNECTED : 'Select a store.';
  } else if (stores.length > 0 && !stores.some((s) => s.id === data.storeId)) {
    e.storeId =
      'That store is not available. Choose a store from the list, or connect Shopify under Settings → Integrations.';
  }
  if (!data.storeName?.trim()) e.storeName = 'Store name is required.';
  if (!data.agentName?.trim()) e.agentName = 'Agent name is required — choose something your team will recognize.';
  if (data.storeUrl?.trim() && !urlPattern.test(data.storeUrl.trim())) {
    e.storeUrl = 'Enter a full URL starting with https://.';
  }
  if (data.storeEmail?.trim() && !emailPattern.test(data.storeEmail.trim())) {
    e.storeEmail = 'Enter a valid store email or leave blank.';
  }
  if (data.supportEmail?.trim() && !emailPattern.test(data.supportEmail.trim())) {
    e.supportEmail = 'Enter a valid support email or leave blank.';
  }
  if (data.supportPhone?.trim() && !phonePattern.test(data.supportPhone.trim())) {
    e.supportPhone = 'Enter a valid support phone number or leave blank.';
  }
  return e;
}

/** Step 2 — Shopify & data sources. */
export function validateStepShopifyConnection(data: CreateAgentFormData): FormErrors {
  const e: FormErrors = {};
  validateShopifyDomain(data, e);
  return e;
}

/** Step 3 — Voice & provider keys. */
export function validateStepVoiceSettings(
  data: CreateAgentFormData,
  opts?: { workspaceElevenlabsConfigured?: boolean },
): FormErrors {
  const e: FormErrors = {};
  const L = AGENT_FIELD_LIMITS;
  if (data.greetingMessage?.length > L.greetingMessage) {
    e.greetingMessage = `Keep the greeting under ${L.greetingMessage} characters.`;
  }
  if (data.fallbackMessage?.length > L.fallbackMessage) {
    e.fallbackMessage = `Keep the fallback message under ${L.fallbackMessage} characters.`;
  }
  validateApiKeyLengths(data, e);
  if (data.voiceProvider === 'elevenlabs') {
    if (!data.voiceId?.trim()) {
      e.voiceId = 'Voice ID or name is required when ElevenLabs is selected.';
    }
    const workspaceReady = opts?.workspaceElevenlabsConfigured === true;
    if (!data.elevenlabsApiKey?.trim() && !workspaceReady) {
      e.elevenlabsApiKey = 'Add an ElevenLabs API key (or switch to OpenAI fallback voice).';
    }
  }
  if (data.languageMode === 'fixed' && !data.fixedLanguage?.trim()) {
    e.fixedLanguage = 'Choose a fixed language, or switch to auto-detect.';
  }
  if (!Array.isArray(data.supportedLanguages) || data.supportedLanguages.length === 0) {
    e.supportedLanguages = 'Select at least one supported language.';
  }
  return e;
}

/** Step 4 — Phone, checkout, and sales / handoff behavior. */
export function validateStepSalesBehavior(data: CreateAgentFormData): FormErrors {
  const e: FormErrors = {};
  if (data.escalationEmail?.trim() && !emailPattern.test(data.escalationEmail.trim())) {
    e.escalationEmail = 'Enter a valid escalation email or leave blank.';
  }
  if (data.escalationPhone?.trim() && !phonePattern.test(data.escalationPhone.trim())) {
    e.escalationPhone = 'Enter a valid escalation phone number or leave blank.';
  }
  if (data.twilioPhoneNumber?.trim() && !phonePattern.test(data.twilioPhoneNumber.trim())) {
    e.twilioPhoneNumber = 'Enter a valid Twilio phone number (E.164 recommended).';
  }
  const L = AGENT_FIELD_LIMITS;
  if (data.returnRefundBehavior.length > L.returnRefundBehavior) {
    e.returnRefundBehavior = maxLen('returnRefundBehavior', 'Returns & refunds', L.returnRefundBehavior);
  }
  if (data.orderStatusHandling.length > L.orderStatusHandling) {
    e.orderStatusHandling = maxLen('orderStatusHandling', 'Order tracking', L.orderStatusHandling);
  }
  if (data.outOfStockHandling.length > L.outOfStockHandling) {
    e.outOfStockHandling = maxLen('outOfStockHandling', 'Out of stock', L.outOfStockHandling);
  }
  if (data.humanHandoffRules.length > L.humanHandoffRules) {
    e.humanHandoffRules = maxLen('humanHandoffRules', 'Human handoff rules', L.humanHandoffRules);
  }
  return e;
}

/** Edit-mode hint: connection tests / stored secrets on the agent (fields stay blank in UI). */
export type LaunchReadinessSavedCredentials = {
  shopify?: 'ok' | 'failed' | 'unknown';
  twilio?: 'ok' | 'failed' | 'unknown';
  openai?: 'ok' | 'failed' | 'unknown';
};

/** Launch-only checks for production safety (non-draft go-live). */
export function validateLaunchReadiness(
  data: CreateAgentFormData,
  workspaceSummary?: { shopify: { configured: boolean }; twilio: { configured: boolean }; openai: { configured: boolean } } | null,
  savedOnAgent?: LaunchReadinessSavedCredentials | null,
): FormErrors {
  const e: FormErrors = {};
  // Match API/runtime: workspace (Settings) integrations satisfy credential requirements even when
  // the form checkbox is off or secret inputs are blank (saved secrets are never refilled in UI).
  const wsShopify = workspaceSummary?.shopify.configured === true;
  const wsTwilio = workspaceSummary?.twilio.configured === true;
  const wsOpenai = workspaceSummary?.openai.configured === true;
  // Same for credentials already stored on the agent (edit wizard shows "Saved (connected)" but does not refill secrets).
  const agShopify = savedOnAgent?.shopify === 'ok';
  const agTwilio = savedOnAgent?.twilio === 'ok';
  const agOpenai = savedOnAgent?.openai === 'ok';
  const shopifyCredOk = wsShopify || agShopify;
  const twilioCredOk = wsTwilio || agTwilio;
  const openaiCredOk = wsOpenai || agOpenai;

  if (!data.shopifyStoreUrl?.trim() && !shopifyCredOk) {
    e.shopifyStoreUrl =
      'Launch requires your Shopify myshopify domain, or connect Shopify under Settings → Integrations.';
  }
  if (!data.shopifyAdminToken?.trim() && !shopifyCredOk) {
    e.shopifyAdminToken =
      'Launch requires a Shopify Admin access token, or connect Shopify under Settings → Integrations.';
  }
  if (!data.openaiApiKey?.trim() && !openaiCredOk) {
    e.openaiApiKey =
      'Launch requires an OpenAI API key, or save one under Settings → Integrations (or set OPENAI_API_KEY on the API server).';
  }
  if (!data.twilioAccountSid?.trim() && !twilioCredOk) {
    e.twilioAccountSid =
      'Launch requires Twilio Account SID, or connect Twilio under Settings → Integrations.';
  }
  if (!data.twilioAuthToken?.trim() && !twilioCredOk) {
    e.twilioAuthToken =
      'Launch requires Twilio Auth Token, or connect Twilio under Settings → Integrations.';
  }
  if (!data.twilioPhoneNumber?.trim() && !twilioCredOk) {
    e.twilioPhoneNumber =
      'Launch requires a Twilio phone number, or connect Twilio under Settings → Integrations.';
  }
  return e;
}

/** Step 5 — Store policies (long text). */
export function validateStepStorePolicies(data: CreateAgentFormData): FormErrors {
  const e: FormErrors = {};
  const max = AGENT_FIELD_LIMITS.policyText;
  if (data.shippingPolicy.length > max) e.shippingPolicy = `Keep under ${max} characters.`;
  if (data.returnPolicy.length > max) e.returnPolicy = `Keep under ${max} characters.`;
  if (data.exchangePolicy.length > max) e.exchangePolicy = `Keep under ${max} characters.`;
  if (data.deliveryNotes.length > max) e.deliveryNotes = `Keep under ${max} characters.`;
  return e;
}

/** Step 6 — AI instructions & safety. */
export function validateStepAIInstructions(data: CreateAgentFormData): FormErrors {
  const e: FormErrors = {};
  const L = AGENT_FIELD_LIMITS;
  if (data.systemPrompt.length > L.systemPrompt) e.systemPrompt = maxLen('systemPrompt', 'Main instructions', L.systemPrompt);
  if (data.agentRole.length > L.agentRole) e.agentRole = maxLen('agentRole', 'Agent role', L.agentRole);
  if (data.agentGoal.length > L.agentGoal) e.agentGoal = maxLen('agentGoal', 'Goal', L.agentGoal);
  if (data.allowedActions.length > L.allowedActions) e.allowedActions = maxLen('allowedActions', 'Allowed actions', L.allowedActions);
  if (data.restrictedActions.length > L.restrictedActions) {
    e.restrictedActions = maxLen('restrictedActions', 'Forbidden actions', L.restrictedActions);
  }
  if (data.escalationInstructions.length > L.escalationInstructions) {
    e.escalationInstructions = maxLen('escalationInstructions', 'Escalation rule', L.escalationInstructions);
  }
  if (data.forbiddenBehaviors.length > L.forbiddenBehaviors) {
    e.forbiddenBehaviors = maxLen('forbiddenBehaviors', 'Forbidden behaviors', L.forbiddenBehaviors);
  }
  return e;
}

/** Minimal checks for “Save as draft” from any step — avoids blocking partial work. */
export function validateDraftSave(data: CreateAgentFormData): FormErrors {
  const e: FormErrors = {};
  if (!data.agentName?.trim()) e.agentName = 'Add at least an agent name to save a draft.';
  if (!data.storeName?.trim()) e.storeName = 'Add a store name to save a draft.';
  return e;
}

/**
 * Clears optional URL/email fields that are non-empty but invalid so Nest validation
 * accepts draft payloads while the user is still filling the form.
 */
export function sanitizeAgentPayloadForDraftApi(data: CreateAgentFormData): CreateAgentFormData {
  const next = { ...data };
  const clearIfBadUrl = (key: keyof CreateAgentFormData) => {
    const v = String(next[key] ?? '').trim();
    if (v && !urlPattern.test(v)) (next as Record<string, unknown>)[key as string] = '';
  };
  const clearIfBadEmail = (key: keyof CreateAgentFormData) => {
    const v = String(next[key] ?? '').trim();
    if (v && !emailPattern.test(v)) (next as Record<string, unknown>)[key as string] = '';
  };
  clearIfBadUrl('storeUrl');
  const shopifyHost = next.shopifyStoreUrl?.trim() ? getHostnameFromShopifyInput(next.shopifyStoreUrl.trim()) : null;
  if (next.shopifyStoreUrl?.trim() && (!shopifyHost || !isMyshopifyDomain(shopifyHost))) {
    next.shopifyStoreUrl = '';
  }
  clearIfBadEmail('storeEmail');
  clearIfBadEmail('supportEmail');
  clearIfBadEmail('escalationEmail');
  return next;
}

/** Short keys / oversized text would fail Nest validation — clear or trim for draft saves only. */
export function clampAgentPayloadForDraftApi(data: CreateAgentFormData): CreateAgentFormData {
  const next = sanitizeAgentPayloadForDraftApi({ ...data });
  const L = AGENT_FIELD_LIMITS;
  const trunc = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

  next.greetingMessage = trunc(next.greetingMessage, L.greetingMessage);
  next.fallbackMessage = trunc(next.fallbackMessage, L.fallbackMessage);
  next.systemPrompt = trunc(next.systemPrompt, L.systemPrompt);
  next.agentRole = trunc(next.agentRole, L.agentRole);
  next.agentGoal = trunc(next.agentGoal, L.agentGoal);
  next.allowedActions = trunc(next.allowedActions, L.allowedActions);
  next.restrictedActions = trunc(next.restrictedActions, L.restrictedActions);
  next.escalationInstructions = trunc(next.escalationInstructions, L.escalationInstructions);
  next.forbiddenBehaviors = trunc(next.forbiddenBehaviors, L.forbiddenBehaviors);
  next.humanHandoffRules = trunc(next.humanHandoffRules, L.humanHandoffRules);
  next.returnRefundBehavior = trunc(next.returnRefundBehavior, L.returnRefundBehavior);
  next.orderStatusHandling = trunc(next.orderStatusHandling, L.orderStatusHandling);
  next.outOfStockHandling = trunc(next.outOfStockHandling, L.outOfStockHandling);
  next.shippingPolicy = trunc(next.shippingPolicy, L.policyText);
  next.returnPolicy = trunc(next.returnPolicy, L.policyText);
  next.exchangePolicy = trunc(next.exchangePolicy, L.policyText);
  next.deliveryNotes = trunc(next.deliveryNotes, L.policyText);
  next.escalationRules = trunc(next.escalationRules, 4000);

  const ok = (k: string, min: number) => k.trim().length >= min;
  if (next.openaiApiKey.trim() && !ok(next.openaiApiKey, 20)) next.openaiApiKey = '';
  if (next.elevenlabsApiKey.trim() && !ok(next.elevenlabsApiKey, 10)) next.elevenlabsApiKey = '';

  return next;
}
