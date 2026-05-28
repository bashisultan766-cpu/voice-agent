'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { normalizePhoneNumber } from '@bookstore-voice-agents/types';
import {
  type AgentApi,
  agentToFormData,
  createAgent,
  formatAgentStatusFailureMessage,
  getAgent,
  mapStatus,
  updateAgent,
  updateAgentStatus,
  getAgentReadiness,
  testAgentConnection,
  testCredentials,
  sendAgentTestEmail,
  type CreateAgentPayload,
  type UpdatedSecretsMeta,
} from '@/lib/api/agents';
import { authenticatedFetch } from '@/lib/api/authenticated-fetch';
import { FormSection } from './FormSection';
import {
  FormField,
  FormInput,
  FormSelect,
  FormTextarea,
  FormCheckbox,
} from './FormField';
import { PasswordField } from './PasswordField';
import { CreateAgentStepper } from './CreateAgentStepper';
import { ToolPermissionsSection } from './ToolPermissionsSection';
import { VoicePersonalitySection } from './VoicePersonalitySection';
import { useToast } from '@/components/ui/Toast';
import { getClients, getStores, type ClientListItem, type StoreListItem } from '@/lib/api/ownership';
import {
  getTenantIntegrationSummary,
  type TenantIntegrationSummary,
} from '@/lib/api/tenant-integrations';
import {
  type CreateAgentFormData,
  type FormErrors,
  type LaunchReadinessSavedCredentials,
  initialFormData,
  validateCreateAgentForm,
  validateStepBasicInfo,
  validateStepShopifyConnection,
  validateStepVoiceSettings,
  validateStepSalesBehavior,
  validateStepStorePolicies,
  validateStepAIInstructions,
  validateDraftSave,
  validateLaunchReadiness,
  firstStepWithErrors,
  stepForFormField,
  type AgentStatus,
  type CreateAgentStep,
} from './form-types';
import { createAgentFullSchema } from '@/lib/validation/create-agent.schema';

const CREATE_AGENT_DRAFT_KEY = 'createAgentForm_draft';

const STATUS_OPTIONS: { value: AgentStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
];

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'ar', label: 'Arabic' },
  { value: 'ur', label: 'Urdu' },
];

const TIMEZONE_OPTIONS = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'Eastern (US)' },
  { value: 'America/Los_Angeles', label: 'Pacific (US)' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Asia/Karachi', label: 'Karachi' },
  { value: 'Asia/Dubai', label: 'Dubai' },
];

const VOICE_PROVIDER_OPTIONS = [
  { value: 'elevenlabs', label: 'ElevenLabs (recommended premium voice)' },
  { value: 'openai', label: 'OpenAI voice (fallback/default)' },
];

const ELEVENLABS_MODEL_OPTIONS = [
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2 (recommended)' },
  { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5 (lower latency)' },
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5 (fastest)' },
];

const LANGUAGE_MODE_OPTIONS = [
  { value: 'auto', label: 'Auto-detect caller language' },
  { value: 'fixed', label: 'Fixed language' },
];

const SUPPORTED_LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'ur', label: 'Urdu' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Arabic' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
];

const CALL_ROUTING_OPTIONS = [
  { value: 'auto', label: 'Auto (agent answers)' },
  { value: 'queue', label: 'Queue then agent' },
  { value: 'voicemail', label: 'Voicemail fallback' },
];

const INCOMING_CALL_OPTIONS = [
  { value: 'answer', label: 'Answer immediately' },
  { value: 'ring_then_answer', label: 'Ring then answer' },
  { value: 'screen', label: 'Screen caller first' },
];

const PROMPT_TEMPLATES: { value: string; label: string; prompt: string }[] = [
  { value: '', label: 'Start from scratch', prompt: '' },
  {
    value: 'customer-support',
    label: 'Customer support agent',
    prompt: 'You are a friendly customer support agent for the store. Your job is to help callers with questions, problems, and requests. Listen carefully, be patient, and give clear answers. If you can resolve the issue using the knowledge base or by looking up an order, do so. If the caller needs a refund, a complaint, or something you cannot do, offer to transfer them to a team member.',
  },
  {
    value: 'order-status',
    label: 'Order status agent',
    prompt: 'You are a helpful voice assistant focused on order status. Callers want to know where their order is, when it will arrive, or how to track it. Look up orders by order number or phone number when possible. Keep answers short and clear. If the caller asks about returns or refunds, briefly explain the policy and offer to transfer to the team if they need to process one.',
  },
  {
    value: 'returns-refunds',
    label: 'Returns & refunds agent',
    prompt: 'You are a returns and refunds specialist for the store. Explain the return policy clearly (e.g. time window, condition of items). You can answer questions about how to start a return or what to expect. You cannot process refunds yourself—offer to transfer the caller to a team member who can. Be empathetic and clear.',
  },
  {
    value: 'sales-assistant',
    label: 'Sales assistant agent',
    prompt: 'You are a helpful sales assistant. Answer questions about products, availability, prices, and promotions. Help callers find what they need and suggest alternatives if something is out of stock. Keep the tone friendly and helpful without being pushy. If they want to place an order or need payment help, offer to transfer to the team.',
  },
];

const TONE_OPTIONS = [
  { value: '', label: 'Select tone (optional)' },
  { value: 'friendly', label: 'Friendly & warm' },
  { value: 'professional', label: 'Professional & clear' },
  { value: 'concise', label: 'Concise & to the point' },
  { value: 'empathetic', label: 'Empathetic & patient' },
];

type TestStatus = 'idle' | 'loading' | 'success' | 'error';
/** Connection tests exposed in the wizard (no direct database credentials for tenants). */
type ConnectionTestTarget = 'shopify' | 'twilio' | 'openai' | 'elevenlabs';
type SavedCredentialStatus = 'ok' | 'failed' | 'unknown';

interface SavedCredentialFlags {
  shopify: SavedCredentialStatus;
  twilio: SavedCredentialStatus;
  openai: SavedCredentialStatus;
  elevenlabs: SavedCredentialStatus;
}

type SaveFeedback = {
  kind: 'success' | 'error';
  message: string;
};

interface CreateAgentFormProps {
  /** When set, form is in edit mode: initial data and submit calls updateAgent. */
  agentId?: string;
  /** Pre-fill form (used when editing). Omit for create. */
  initialData?: CreateAgentFormData;
  /** Existing connection health from backend; used to show "credential already saved" badges in edit mode. */
  savedCredentials?: SavedCredentialFlags;
  /** Last time credentials were tested (from backend). */
  lastTestedAt?: string | null;
  /** Server action: POST /api/agents to persist the agent. */
  createAgentAction?: (payload: unknown) => Promise<{ ok: boolean; message: string; agentId?: string }>;
  /** Server action: POST /api/agents/test-credentials/shopify (live Admin API check). */
  testShopifyAction?: (input: {
    shopifyStoreUrl?: string;
    shopifyAdminToken?: string;
  }) => Promise<{ success: boolean; message: string; warnings?: string[] }>;
  /** After a successful edit save — refetch agent/readiness in parent. */
  onAgentSaved?: () => void | Promise<void>;
}

const SECRET_KEYS: (keyof CreateAgentFormData)[] = [
  'shopifyAdminToken', 'shopifyApiKey', 'shopifyApiSecret', 'webhookSecret',
  'databaseUrl', 'databaseAccessToken', 'twilioAccountSid', 'twilioAuthToken',
  'openaiApiKey', 'elevenlabsApiKey', 'resendApiKey',
];

function loadDraftFromStorage(): { data: CreateAgentFormData; step: CreateAgentStep; savedAt: string | null } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CREATE_AGENT_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: Record<string, unknown>; step?: number; savedAt?: string };
    if (!parsed?.data || typeof parsed.data !== 'object') return null;
    const data = { ...initialFormData, ...parsed.data } as CreateAgentFormData;
    const step = typeof parsed.step === 'number' && parsed.step >= 1 && parsed.step <= 7
      ? (parsed.step as CreateAgentStep)
      : 1;
    return { data, step, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null };
  } catch {
    return null;
  }
}

function saveDraftToStorage(data: CreateAgentFormData, step: CreateAgentStep) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CREATE_AGENT_DRAFT_KEY,
      JSON.stringify({ data, step, savedAt: new Date().toISOString() }),
    );
  } catch {
    /* ignore */
  }
}

/** After clients/stores load (or refresh), fill single-option defaults and drop stale store ids — including when a local draft left `storeId` empty. */
function mergeOwnershipIntoFormData(
  prev: CreateAgentFormData,
  clientRows: ClientListItem[],
  storeRows: StoreListItem[],
): CreateAgentFormData {
  const next = { ...prev };
  const storeIds = new Set(storeRows.map((s) => s.id));
  if (clientRows.length === 1 && !next.clientId?.trim()) {
    next.clientId = clientRows[0].id;
  }
  if (storeRows.length === 1) {
    if (!next.storeId?.trim() || !storeIds.has(next.storeId)) {
      next.storeId = storeRows[0].id;
    }
  } else if (next.storeId?.trim() && !storeIds.has(next.storeId)) {
    next.storeId = '';
  }
  return next;
}

function normalizeShopifyDomain(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  try {
    const parsed = raw.match(/^https?:\/\//i) ? new URL(raw) : new URL(`https://${raw}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function FieldHelpLinks({
  links,
}: {
  links: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Where to find this:</span>
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-violet-600 hover:underline dark:text-violet-400"
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}

function SavedBadge({ status, onClick }: { status: SavedCredentialStatus; onClick?: () => void }) {
  const cls = status === 'ok'
    ? 'border-emerald-100 bg-emerald-50 text-emerald-700'
    : status === 'failed'
      ? 'border-red-100 bg-red-50 text-red-700'
      : 'border-slate-200 bg-slate-50 text-slate-600';
  const text = status === 'ok'
    ? 'Saved (connected)'
    : status === 'failed'
      ? 'Saved (needs update)'
      : 'Saved (not tested)';
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium hover:opacity-90 ${cls}`}
        title="Click to retest connection"
      >
        {text}
      </button>
    );
  }
  if (status === 'ok') {
    return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
  }
  if (status === 'failed') {
    return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
  }
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

function SecretFieldBadge({ status }: { status?: SavedCredentialStatus }) {
  if (!status) return null;
  return <SavedBadge status={status} />;
}

function resolveCredentialStatus(
  saved: SavedCredentialStatus | undefined,
  test: TestStatus | undefined,
): SavedCredentialStatus {
  if (test === 'success') return 'ok';
  if (test === 'error') return 'failed';
  return saved ?? 'unknown';
}

function formatSecretUpdateMessage(updatedSecrets?: UpdatedSecretsMeta): string {
  if (!updatedSecrets) return 'Changes saved.';
  const entries: Array<[string, keyof UpdatedSecretsMeta]> = [
    ['Shopify admin token', 'shopifyAdminToken'],
    ['Twilio SID', 'twilioAccountSid'],
    ['Twilio auth token', 'twilioAuthToken'],
    ['OpenAI key', 'openaiApiKey'],
    ['ElevenLabs key', 'elevenlabsApiKey'],
  ];
  const updated = entries.filter(([, key]) => updatedSecrets[key]).map(([label]) => label);
  if (updated.length === 0) return 'Changes saved. Existing secret keys were kept.';
  return `Changes saved. Updated ${updated.join(', ')}.`;
}

function CredentialStatusPanel({
  savedCredentials,
  testStatus,
  onTestAll,
  onRetest,
  testingAll,
  includeElevenLabs,
}: {
  savedCredentials?: SavedCredentialFlags;
  testStatus: Record<ConnectionTestTarget, TestStatus>;
  onTestAll: () => void;
  onRetest: (target: ConnectionTestTarget) => void;
  testingAll: boolean;
  includeElevenLabs: boolean;
}) {
  const rows: Array<{
    label: string;
    target: ConnectionTestTarget;
    status: SavedCredentialStatus;
    loading: boolean;
  }> = [
    {
      label: 'Shopify',
      target: 'shopify',
      status: resolveCredentialStatus(savedCredentials?.shopify, testStatus.shopify),
      loading: testStatus.shopify === 'loading',
    },
    {
      label: 'Twilio',
      target: 'twilio',
      status: resolveCredentialStatus(savedCredentials?.twilio, testStatus.twilio),
      loading: testStatus.twilio === 'loading',
    },
    {
      label: 'OpenAI',
      target: 'openai',
      status: resolveCredentialStatus(savedCredentials?.openai, testStatus.openai),
      loading: testStatus.openai === 'loading',
    },
  ];
  if (includeElevenLabs) {
    rows.push({
      label: 'ElevenLabs',
      target: 'elevenlabs',
      status: resolveCredentialStatus(savedCredentials?.elevenlabs, testStatus.elevenlabs),
      loading: testStatus.elevenlabs === 'loading',
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Credential status</p>
          <p className="text-xs text-muted-foreground">
            Saved keys remain hidden by design. Use test checks to confirm connectivity.
          </p>
        </div>
        <button
          type="button"
          onClick={onTestAll}
          disabled={testingAll}
          className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          {testingAll ? 'Testing credentials…' : 'Test all credentials'}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {rows.map((row) => (
          <div key={row.label} className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <span>{row.label}:</span>
            {row.loading ? <span>Testing…</span> : <SavedBadge status={row.status} />}
            <button
              type="button"
              onClick={() => onRetest(row.target)}
              disabled={row.loading}
              className="rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              Retest
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** UTC, deterministic — locale dates break SSR/client hydration and can freeze the form. */
function formatLastTested(value?: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function CreateAgentForm({
  agentId,
  initialData,
  savedCredentials,
  lastTestedAt,
  createAgentAction,
  testShopifyAction,
  onAgentSaved,
}: CreateAgentFormProps) {
  const [step, setStep] = useState<CreateAgentStep>(1);
  const [setupMode, setSetupMode] = useState<'simple' | 'advanced'>(agentId ? 'advanced' : 'simple');
  const [data, setData] = useState<CreateAgentFormData>(initialData ?? initialFormData);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [workspaceSummary, setWorkspaceSummary] = useState<TenantIntegrationSummary | null>(null);
  const workspaceElevenlabsConfigured = Boolean(workspaceSummary?.elevenlabs?.configured);
  /** From GET /api/voice/config-check — agent secrets + workspace both have OpenAI material. */
  const [openaiOverridesWorkspaceWarning, setOpenaiOverridesWorkspaceWarning] = useState(false);
  const [ownershipLoading, setOwnershipLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** Which save action is in flight (for button labels). */
  const [submitKind, setSubmitKind] = useState<'draft' | 'live' | null>(null);
  const [creationSuccess, setCreationSuccess] = useState<{
    agentId: string;
    agentName: string;
    savedAsDraft: boolean;
  } | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null);
  const [restoredDraftAt, setRestoredDraftAt] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<Record<ConnectionTestTarget, TestStatus>>({
    shopify: 'idle',
    twilio: 'idle',
    openai: 'idle',
    elevenlabs: 'idle',
  });
  const [testError, setTestError] = useState<Record<ConnectionTestTarget, string>>({
    shopify: '',
    twilio: '',
    openai: '',
    elevenlabs: '',
  });
  const [testWarning, setTestWarning] = useState<Record<ConnectionTestTarget, string>>({
    shopify: '',
    twilio: '',
    openai: '',
    elevenlabs: '',
  });
  const [testSource, setTestSource] = useState<Record<ConnectionTestTarget, string>>({
    shopify: '',
    twilio: '',
    openai: '',
    elevenlabs: '',
  });
  /** Merges server-reported saved credential health with in-session test results (edit wizard). */
  const launchReadinessSavedHint = useMemo((): LaunchReadinessSavedCredentials | null => {
    if (!savedCredentials) return null;
    return {
      shopify: resolveCredentialStatus(savedCredentials.shopify, testStatus.shopify),
      twilio: resolveCredentialStatus(savedCredentials.twilio, testStatus.twilio),
      openai: resolveCredentialStatus(savedCredentials.openai, testStatus.openai),
    };
  }, [savedCredentials, testStatus.shopify, testStatus.twilio, testStatus.openai]);
  const initialDataRef = useRef(initialData ?? initialFormData);
  const hasLoadedDraft = useRef(false);
  const { addToast } = useToast();
  const router = useRouter();

  const reloadClientsAndStores = useCallback(() => {
    setOwnershipLoading(true);
    Promise.all([getClients(), getStores()])
      .then(([clientRows, storeRows]) => {
        setClients(clientRows);
        setStores(storeRows);
        setData((p) => mergeOwnershipIntoFormData(p, clientRows, storeRows));
        void getTenantIntegrationSummary()
          .then((s) => setWorkspaceSummary(s))
          .catch(() => setWorkspaceSummary(null));
      })
      .catch((err) => {
        addToast('error', err instanceof Error ? err.message : 'Failed to load clients/stores.');
      })
      .finally(() => setOwnershipLoading(false));
  }, [addToast]);

  // Load saved draft when creating a new agent (not editing)
  useEffect(() => {
    let cancelled = false;
    setOwnershipLoading(true);
    Promise.all([getClients(), getStores()])
      .then(([clientRows, storeRows]) => {
        if (cancelled) return;
        setClients(clientRows);
        setStores(storeRows);
        setData((p) => mergeOwnershipIntoFormData(p, clientRows, storeRows));
        void getTenantIntegrationSummary()
          .then((s) => {
            if (!cancelled) setWorkspaceSummary(s);
          })
          .catch(() => {
            if (!cancelled) setWorkspaceSummary(null);
          });
      })
      .catch((err) => {
        if (cancelled) return;
        addToast('error', err instanceof Error ? err.message : 'Failed to load clients/stores.');
      })
      .finally(() => {
        if (!cancelled) setOwnershipLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [addToast]);

  useEffect(() => {
    if (!agentId) {
      setOpenaiOverridesWorkspaceWarning(false);
      return;
    }
    void authenticatedFetch(`/api/voice/config-check?agentId=${encodeURIComponent(agentId)}`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { agentOverridesWorkspaceOpenai?: boolean } | null) => {
        setOpenaiOverridesWorkspaceWarning(Boolean(j?.agentOverridesWorkspaceOpenai));
      })
      .catch(() => setOpenaiOverridesWorkspaceWarning(false));
  }, [agentId, workspaceSummary?.openai?.configured]);

  useEffect(() => {
    if (agentId || initialData) return;
    if (hasLoadedDraft.current) return;
    hasLoadedDraft.current = true;
    const draft = loadDraftFromStorage();
    if (draft) {
      setData(draft.data);
      setStep(draft.step);
      setRestoredDraftAt(draft.savedAt);
    }
  }, [agentId, initialData]);

  // In simple mode, prefill safe defaults so non-technical users can launch faster.
  useEffect(() => {
    if (agentId || setupMode !== 'simple') return;
    setData((prev) => {
      if (prev.promptTemplate || prev.systemPrompt || prev.agentRole || prev.agentGoal || prev.restrictedActions || prev.forbiddenBehaviors) {
        return prev;
      }
      const storeName = prev.storeName?.trim() || 'the store';
      const tpl = PROMPT_TEMPLATES.find((x) => x.value === 'customer-support');
      return {
        ...prev,
        promptTemplate: 'customer-support',
        toneOfVoice: prev.toneOfVoice || 'friendly',
        agentRole: `Customer support voice agent for ${storeName}`,
        agentGoal: 'Help callers with product questions, order updates, and support requests clearly and safely.',
        restrictedActions: 'Do not process payments directly. Do not collect full card details. Do not invent prices, stock, or policies.',
        forbiddenBehaviors: 'Never request raw card numbers/CVV. Never claim actions completed without tool confirmation.',
        escalationInstructions:
          'Escalate to a human for refund disputes, complaints, legal threats, high-value custom orders, or when the caller requests a person.',
        systemPrompt: tpl?.prompt || prev.systemPrompt,
      };
    });
  }, [agentId, setupMode]);

  // Persist form to localStorage (create flow only), debounced
  useEffect(() => {
    if (agentId) return;
    const t = setTimeout(() => saveDraftToStorage(data, step), 500);
    return () => clearTimeout(t);
  }, [agentId, data, step]);

  const clearSavedDraft = useCallback(() => {
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(CREATE_AGENT_DRAFT_KEY);
    } catch {
      /* ignore */
    }
    setData(initialFormData);
    setStep(1);
    setErrors({});
    setTestStatus({ shopify: 'idle', twilio: 'idle', openai: 'idle', elevenlabs: 'idle' });
    setTestError({ shopify: '', twilio: '', openai: '', elevenlabs: '' });
    setTestWarning({ shopify: '', twilio: '', openai: '', elevenlabs: '' });
    setTestSource({ shopify: '', twilio: '', openai: '', elevenlabs: '' });
    setIsDirty(false);
    setRestoredDraftAt(null);
    hasLoadedDraft.current = true;
    addToast('success', 'Saved form cleared. You can start fresh.');
  }, [addToast]);

  const update = useCallback(<K extends keyof CreateAgentFormData>(key: K, value: CreateAgentFormData[K]) => {
    setData((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
        if (key === 'useWorkspaceDefaults') {
          const next = { ...prev };
          for (const k of [
            'shopifyStoreUrl',
            'shopifyAdminToken',
            'openaiApiKey',
            'twilioAccountSid',
            'twilioAuthToken',
            'twilioPhoneNumber',
          ] as const) {
            delete next[k];
          }
          return next;
        }
        if (prev[key as string] === undefined) return prev;
        const next = { ...prev };
        delete next[key as string];
        return next;
      });
    setIsDirty(true);
    setSaveFeedback(null);
    if (key === 'shopifyStoreUrl' || key === 'shopifyAdminToken') {
      setTestStatus((prev) => ({ ...prev, shopify: 'idle' as const }));
      setTestError((prev) => ({ ...prev, shopify: '' }));
      setTestWarning((prev) => ({ ...prev, shopify: '' }));
    } else if (key === 'twilioAccountSid' || key === 'twilioAuthToken' || key === 'twilioPhoneNumber') {
      setTestStatus((prev) => ({ ...prev, twilio: 'idle' as const }));
      setTestError((prev) => ({ ...prev, twilio: '' }));
      setTestWarning((prev) => ({ ...prev, twilio: '' }));
    } else if (key === 'openaiApiKey') {
      setTestStatus((prev) => ({ ...prev, openai: 'idle' as const }));
      setTestError((prev) => ({ ...prev, openai: '' }));
      setTestWarning((prev) => ({ ...prev, openai: '' }));
      setTestSource((prev) => ({ ...prev, openai: '' }));
    } else if (key === 'elevenlabsApiKey') {
      setTestStatus((prev) => ({ ...prev, elevenlabs: 'idle' as const }));
      setTestError((prev) => ({ ...prev, elevenlabs: '' }));
      setTestWarning((prev) => ({ ...prev, elevenlabs: '' }));
      setTestSource((prev) => ({ ...prev, elevenlabs: '' }));
    }
  }, []);

  const runTest = useCallback(
    async (target: ConnectionTestTarget) => {
      const name =
        target === 'shopify'
          ? 'Shopify'
          : target === 'twilio'
            ? 'Twilio'
            : target === 'openai'
              ? 'OpenAI'
              : 'ElevenLabs';
      if (target === 'shopify') {
        if (!data.shopifyStoreUrl?.trim()) {
          addToast('error', 'Enter Shopify myshopify domain to test the connection.');
          return;
        }
        if (!data.shopifyAdminToken?.trim() && !agentId) {
          addToast('error', 'Enter Shopify Admin access token to test the connection.');
          return;
        }
      } else if (target === 'twilio') {
        if (!data.twilioAccountSid?.trim() && !agentId) {
          addToast('error', 'Enter Twilio Account SID to test the connection.');
          return;
        }
        if (!data.twilioAuthToken?.trim() && !agentId) {
          addToast('error', 'Enter Twilio Auth Token to test the connection.');
          return;
        }
      } else if (target === 'openai') {
        if (!data.openaiApiKey?.trim() && !agentId && !data.useWorkspaceDefaults && !workspaceSummary?.openai?.configured) {
          addToast('error', 'Enter OpenAI API key to test the connection.');
          return;
        }
      } else if (target === 'elevenlabs') {
        if (!data.elevenlabsApiKey?.trim() && !agentId && !workspaceElevenlabsConfigured) {
          addToast('error', 'Enter ElevenLabs API key to test the connection.');
          return;
        }
        if (!data.voiceId?.trim()) {
          addToast('error', 'Enter ElevenLabs voice ID or name before testing.');
          return;
        }
      }
      setTestStatus((prev) => ({ ...prev, [target]: 'loading' }));
      setTestError((prev) => ({ ...prev, [target]: '' }));
      setTestWarning((prev) => ({ ...prev, [target]: '' }));
      try {
        if (target === 'shopify' && !agentId && testShopifyAction) {
          const shopifyTestResult = await testShopifyAction({
            shopifyStoreUrl: data.shopifyStoreUrl,
            shopifyAdminToken: data.shopifyAdminToken,
          });
          setTestStatus((prev) => ({
            ...prev,
            shopify: shopifyTestResult.success ? 'success' : 'error',
          }));
          setTestError((prev) => ({
            ...prev,
            shopify: shopifyTestResult.success ? '' : shopifyTestResult.message,
          }));
          const warningText =
            Array.isArray(shopifyTestResult.warnings) && shopifyTestResult.warnings.length > 0
              ? shopifyTestResult.warnings.join(' ')
              : '';
          setTestWarning((prev) => ({ ...prev, shopify: warningText }));
          if (shopifyTestResult.success) addToast('success', shopifyTestResult.message);
          else addToast('error', shopifyTestResult.message);
          return;
        }
        const result = agentId
          ? await testAgentConnection(agentId, target, data)
          : await testCredentials(target, data);
        const errMsg = result.success ? '' : (result.message || `${name} connection failed.`);
        const warningText =
          Array.isArray(result.warnings) && result.warnings.length > 0
            ? result.warnings.join(' ')
            : '';
        setTestStatus((prev) => ({ ...prev, [target]: result.success ? 'success' : 'error' }));
        setTestError((prev) => ({ ...prev, [target]: errMsg }));
        setTestWarning((prev) => ({ ...prev, [target]: warningText }));
        setTestSource((prev) => ({ ...prev, [target]: result.source ? `using ${result.source} credential` : '' }));
        if (result.success) {
          const shop = (result as { shop?: { name?: string } }).shop?.name;
          const msg = shop ? `${result.message || name + ' connection successful.'} Connected to ${shop}.` : (result.message || `${name} connection successful.`);
          addToast('success', msg);
        } else {
          addToast('error', errMsg);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : `${name} test failed.`;
        setTestStatus((prev) => ({ ...prev, [target]: 'error' }));
        setTestError((prev) => ({ ...prev, [target]: errMsg }));
        setTestWarning((prev) => ({ ...prev, [target]: '' }));
        setTestSource((prev) => ({ ...prev, [target]: '' }));
        addToast('error', errMsg);
      }
    },
    [addToast, data, agentId, testShopifyAction, workspaceElevenlabsConfigured, workspaceSummary?.openai?.configured],
  );

  const goNext = useCallback(() => {
    if (step === 1 && ownershipLoading) {
      addToast('error', 'Still loading clients and stores…');
      return;
    }
    const runners: Partial<Record<CreateAgentStep, () => FormErrors>> = {
      1: () => validateStepBasicInfo(data, stores),
      2: () => validateStepShopifyConnection(data),
      3: () =>
        validateStepVoiceSettings(data, {
          workspaceElevenlabsConfigured,
        }),
      4: () => validateStepSalesBehavior(data),
      5: () => validateStepStorePolicies(data),
      6: () => validateStepAIInstructions(data),
    };
    const run = runners[step];
    if (run) {
      const e = run();
      setErrors(e as Record<string, string>);
      if (Object.keys(e).length > 0) {
        addToast('error', 'Please fix the highlighted fields before continuing.');
        return;
      }
    }
    if (step < 7) setStep((s) => (s + 1) as CreateAgentStep);
  }, [step, data, stores, ownershipLoading, addToast, workspaceElevenlabsConfigured]);

  const canJumpToStep = useCallback(
    (target: CreateAgentStep): boolean => {
      if (target <= step) return true;
      if (target > step && ownershipLoading) {
        addToast('error', 'Still loading clients and stores…');
        return false;
      }
      const runners: Partial<Record<CreateAgentStep, () => FormErrors>> = {
        1: () => validateStepBasicInfo(data, stores),
        2: () => validateStepShopifyConnection(data),
        3: () =>
          validateStepVoiceSettings(data, {
            workspaceElevenlabsConfigured,
          }),
        4: () => validateStepSalesBehavior(data),
        5: () => validateStepStorePolicies(data),
        6: () => validateStepAIInstructions(data),
      };
      for (let s = step; s < target; s++) {
        const run = runners[s as CreateAgentStep];
        if (!run) continue;
        const e = run();
        if (Object.keys(e).length > 0) {
          setErrors(e as Record<string, string>);
          setStep(s as CreateAgentStep);
          addToast('error', 'Please fix the highlighted fields before continuing.');
          return false;
        }
      }
      return true;
    },
    [step, data, stores, ownershipLoading, addToast, workspaceElevenlabsConfigured],
  );

  const goBack = useCallback(() => {
    if (step > 1) setStep((s) => (s - 1) as CreateAgentStep);
  }, [step]);

  const jumpToFormField = useCallback((fieldKey: string) => {
    const st = stepForFormField(fieldKey);
    if (st === null) return;
    setStep(st);
    window.setTimeout(() => {
      document.getElementById(fieldKey)?.focus();
    }, 50);
  }, []);

  const handleSubmit = useCallback(
    async (asDraft: boolean, redirectToDetails = false) => {
      setSaveFeedback(null);
      if (asDraft) {
        const draftErrors = validateDraftSave(data);
        setErrors(draftErrors as Record<string, string>);
        if (Object.keys(draftErrors).length > 0) {
          addToast('error', draftErrors.agentName || draftErrors.storeName || 'Add agent and store names to save a draft.');
          return;
        }
      } else {
        const nextErrors = validateCreateAgentForm(data, stores);
        const readinessErrors = validateLaunchReadiness(data, workspaceSummary, launchReadinessSavedHint);
        const mergedErrors = { ...nextErrors, ...readinessErrors };
        setErrors(mergedErrors as Record<string, string>);
        if (Object.keys(mergedErrors).length > 0) {
          const st = firstStepWithErrors(mergedErrors);
          if (st !== null) setStep(st);
          addToast('error', 'Please complete required launch fields before launching the agent.');
          return;
        }
        if (!agentId) {
          const parseResult = createAgentFullSchema.safeParse(data);
          if (!parseResult.success) {
            const msg = parseResult.error.issues[0]?.message || 'Please complete required fields with valid values.';
            addToast('error', msg);
            return;
          }
        }
      }

      setSubmitKind(asDraft ? 'draft' : 'live');
      setSubmitting(true);
      try {
        const { promptTemplate: _, ...rest } = data;
        const payload: CreateAgentPayload = {
          ...rest,
          agentStatus: !agentId ? (asDraft ? 'draft' : 'active') : data.agentStatus,
        };
        console.log({
          event: 'agent.edit.submit.debug',
          useWorkspaceOpenai: payload.useWorkspaceOpenai,
          useWorkspaceTwilio: payload.useWorkspaceTwilio,
          agentStatus: payload.agentStatus,
          hasOpenAiKey: Boolean(payload.openaiApiKey?.trim()),
          hasTwilioSid: Boolean(payload.twilioAccountSid?.trim()),
        });
        if (agentId) {
          const requestedStatus = payload.agentStatus;
          const statusChanged = requestedStatus !== initialDataRef.current.agentStatus;
          if (payload.agentStatus === initialDataRef.current.agentStatus) {
            delete payload.agentStatus;
          }
          for (const key of SECRET_KEYS) {
            const v = payload[key];
            if (typeof v === 'string' && !v.trim()) {
              delete payload[key];
            }
          }
          const updated = await updateAgent(agentId, payload as Parameters<typeof updateAgent>[1]);
          if (statusChanged && requestedStatus) {
            const statusRes = await updateAgentStatus(agentId, requestedStatus);
            if (requestedStatus === 'active' && statusRes.goLiveStatus === 'CONFIG_REQUIRED') {
              throw new Error(formatAgentStatusFailureMessage(statusRes.failures));
            }
          }
          const refreshed = await getAgent(agentId);
          const latestAgent = (refreshed ?? (updated as AgentApi));
          if (statusChanged && requestedStatus) {
            const persisted = mapStatus(latestAgent.status);
            if (persisted !== requestedStatus) {
              throw new Error(
                `Status save failed: requested ${requestedStatus.toUpperCase()} but saved ${persisted.toUpperCase()}.`,
              );
            }
          }
          const mappedForm = agentToFormData(latestAgent);
          const nextFormData: CreateAgentFormData = {
            ...initialFormData,
            ...mappedForm,
            escalationRules: Array.isArray(mappedForm.escalationRules)
              ? mappedForm.escalationRules.join('\n')
              : (mappedForm.escalationRules ?? ''),
            checkoutMode: mappedForm.checkoutMode === 'draft_order' ? 'draft_order' : 'cart',
          };
          setData(nextFormData);
          initialDataRef.current = nextFormData;
          setIsDirty(false);
          const secretMessage = formatSecretUpdateMessage(updated.updatedSecrets);
          const initialPhone = (initialData?.twilioPhoneNumber ?? '').trim();
          const submittedPhone = (data.twilioPhoneNumber ?? '').trim();
          const phoneLinkMessage =
            initialPhone !== submittedPhone && submittedPhone
              ? 'Phone number updated and linked to this agent.'
              : '';
          let readinessNote = '';
          try {
            const readiness = await getAgentReadiness(agentId);
            const failed = readiness.failures?.length ?? 0;
            readinessNote =
              failed === 0
                ? 'Readiness: all checks passed — you can Make Live from the agents list.'
                : `Readiness: ${failed} item(s) still need attention (see agent details).`;
          } catch {
            readinessNote = '';
          }
          const successMessage =
            [phoneLinkMessage, secretMessage, readinessNote].filter(Boolean).join(' ').trim() || 'Changes saved.';
          setSaveFeedback({ kind: 'success', message: successMessage });
          addToast('success', successMessage);
          await onAgentSaved?.();
          if (redirectToDetails) {
            router.push(`/dashboard/agents/${agentId}`);
            router.refresh();
          }
        } else {
          if (createAgentAction) {
            const result = await createAgentAction(payload);
            if (!result.ok) throw new Error(result.message);
            addToast('success', asDraft ? 'Draft saved to your account.' : 'Agent launched successfully.');
            if (result.agentId) {
              try {
                if (typeof window !== 'undefined') window.localStorage.removeItem(CREATE_AGENT_DRAFT_KEY);
              } catch {
                /* ignore */
              }
              setCreationSuccess({
                agentId: result.agentId,
                agentName: data.agentName.trim() || 'Your agent',
                savedAsDraft: asDraft,
              });
            } else {
              router.push('/dashboard/agents');
              router.refresh();
            }
          } else {
            const created = await createAgent(payload);
            addToast('success', asDraft ? 'Draft saved to your account.' : 'Agent launched successfully.');
            if (created?.id) {
              try {
                if (typeof window !== 'undefined') window.localStorage.removeItem(CREATE_AGENT_DRAFT_KEY);
              } catch {
                /* ignore */
              }
              setCreationSuccess({
                agentId: created.id,
                agentName: data.agentName.trim() || 'Your agent',
                savedAsDraft: asDraft,
              });
            } else {
              router.push('/dashboard/agents');
              router.refresh();
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to save agent.';
        setSaveFeedback({ kind: 'error', message });
        addToast('error', message);
      } finally {
        setSubmitting(false);
        setSubmitKind(null);
      }
    },
    [data, stores, workspaceSummary, launchReadinessSavedHint, addToast, router, agentId, createAgentAction, initialData, onAgentSaved],
  );

  const runRequiredLaunchChecks = useCallback(async () => {
    const readinessErrors = validateLaunchReadiness(data, workspaceSummary, launchReadinessSavedHint);
    if (Object.keys(readinessErrors).length > 0) {
      setErrors((prev) => ({ ...prev, ...(readinessErrors as Record<string, string>) }));
      const st = firstStepWithErrors(readinessErrors);
      if (st !== null) setStep(st);
      addToast('error', 'Add the required launch fields first, then run required checks.');
      return;
    }
    await runTest('shopify');
    await runTest('openai');
    await runTest('twilio');
    addToast('success', 'Required checks finished (Shopify, OpenAI, Twilio). Review results below.');
  }, [addToast, data, workspaceSummary, launchReadinessSavedHint, runTest]);

  const runAllCredentialChecks = useCallback(async () => {
    await runTest('shopify');
    await runTest('twilio');
    await runTest('openai');
    if (data.voiceProvider === 'elevenlabs' && data.voiceId?.trim()) {
      await runTest('elevenlabs');
    }
    addToast('success', 'Credential checks completed. Review statuses above.');
  }, [addToast, data.voiceId, data.voiceProvider, runTest]);

  const handleCancel = useCallback(() => {
    if (isDirty && !confirm('You have unsaved changes. Leave anyway?')) return;
    router.push(agentId ? `/dashboard/agents/${agentId}` : '/dashboard/agents');
  }, [isDirty, agentId, router]);

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!agentId) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!submitting) void handleSubmit(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agentId, submitting, handleSubmit]);

  const isEditMode = !!agentId;
  const isTestingAnyCredential = Object.values(testStatus).some((s) => s === 'loading');
  const launchReadiness = validateLaunchReadiness(data, workspaceSummary, launchReadinessSavedHint);
  const launchReady = Object.keys(launchReadiness).length === 0;
  const primaryBtn =
    'rounded-lg border border-border bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:ring-offset-2';
  const secondaryBtn =
    'rounded-lg border border-border bg-background px-5 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2';
  const nextBtn =
    'rounded-lg border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:ring-offset-2';

  if (creationSuccess && !agentId) {
    return (
      <WizardSuccessScreen
        agentId={creationSuccess.agentId}
        agentName={creationSuccess.agentName}
        savedAsDraft={creationSuccess.savedAsDraft}
        onViewAgent={() => {
          const id = creationSuccess.agentId;
          setCreationSuccess(null);
          router.push(`/dashboard/agents/${id}`);
          router.refresh();
        }}
        onCreateAnother={() => {
          setCreationSuccess(null);
          setData(initialFormData);
          setStep(1);
          setErrors({});
          setIsDirty(false);
          setTestStatus({ shopify: 'idle', twilio: 'idle', openai: 'idle', elevenlabs: 'idle' });
          setTestError({ shopify: '', twilio: '', openai: '', elevenlabs: '' });
          setTestWarning({ shopify: '', twilio: '', openai: '', elevenlabs: '' });
          setTestSource({ shopify: '', twilio: '', openai: '', elevenlabs: '' });
        }}
      />
    );
  }

  return (
    <div className="space-y-10">
      {isEditMode && (
        <CredentialStatusPanel
          savedCredentials={savedCredentials}
          testStatus={testStatus}
          onTestAll={() => {
            void runAllCredentialChecks();
          }}
          onRetest={(target) => {
            void runTest(target);
          }}
          testingAll={isTestingAnyCredential}
          includeElevenLabs={data.voiceProvider === 'elevenlabs'}
        />
      )}
      {!isEditMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Setup mode</p>
            <p className="text-xs text-muted-foreground">
              Simple shows only launch essentials. Advanced unlocks full integration and policy controls.
            </p>
          </div>
          <div className="inline-flex items-center rounded-lg border border-border bg-background p-1">
            <button
              type="button"
              onClick={() => setSetupMode('simple')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                setupMode === 'simple' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Simple
            </button>
            <button
              type="button"
              onClick={() => setSetupMode('advanced')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                setupMode === 'advanced' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Advanced
            </button>
          </div>
        </div>
      )}
      <CreateAgentStepper
        currentStep={step}
        onStepClick={(s) => {
          if (canJumpToStep(s)) setStep(s);
        }}
        mode={isEditMode ? 'edit' : 'create'}
      />

      <form onSubmit={(e) => e.preventDefault()} className="space-y-6 pb-32">
        {isEditMode && saveFeedback && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              saveFeedback.kind === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200'
            }`}
            role={saveFeedback.kind === 'success' ? 'status' : 'alert'}
          >
            {saveFeedback.message}
          </div>
        )}
        {!agentId && restoredDraftAt && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
            Restored your saved draft from this device
            {` (${new Date(restoredDraftAt).toLocaleString()}).`}
          </div>
        )}
        {step === 1 && (
          <StepBasicInfo
            data={data}
            update={update}
            errors={errors}
            onValidate={() => setErrors(validateStepBasicInfo(data, stores) as Record<string, string>)}
            isEdit={isEditMode}
            clients={clients}
            stores={stores}
            ownershipLoading={ownershipLoading}
            workspaceSummary={workspaceSummary}
            onRefreshStores={reloadClientsAndStores}
          />
        )}
        {step === 2 && (
          <StepShopify
            data={data}
            update={update}
            errors={errors}
            testStatus={testStatus}
            testError={testError}
            testWarning={testWarning}
            onTest={runTest}
            isEdit={!!agentId}
            savedStatus={savedCredentials?.shopify}
            lastTestedAt={lastTestedAt}
            setupMode={setupMode}
          />
        )}
        {step === 3 && (
          <StepVoiceSettings
            data={data}
            update={update}
            errors={errors}
            testStatus={testStatus}
            testError={testError}
            testWarning={testWarning}
            onTest={runTest}
            isEdit={!!agentId}
            openaiSavedStatus={savedCredentials?.openai}
            elevenlabsSavedStatus={savedCredentials?.elevenlabs}
            lastTestedAt={lastTestedAt}
            workspaceSummary={workspaceSummary}
            onValidate={() =>
              setErrors(
                validateStepVoiceSettings(data, {
                  workspaceElevenlabsConfigured,
                }) as Record<string, string>,
              )
            }
          />
        )}
        {step === 4 && (
          <StepSalesBehavior
            data={data}
            update={update}
            errors={errors}
            testStatus={testStatus}
            testError={testError}
            testWarning={testWarning}
            onTest={runTest}
            isEdit={!!agentId}
            agentId={agentId}
            savedStatus={savedCredentials?.twilio}
            resendSaved={Boolean((agentId && data.resendApiKey === '') || data.useWorkspaceEmail)}
            workspaceEmailConfigured={Boolean(workspaceSummary?.email?.configured)}
            lastTestedAt={lastTestedAt}
            onValidate={() => setErrors(validateStepSalesBehavior(data) as Record<string, string>)}
            onTestEmail={agentId ? async () => {
              const result = await sendAgentTestEmail(agentId, {
                toEmail: data.emailTestRecipient?.trim() || undefined,
              });
              if (result.success) addToast('success', result.message);
              else addToast('error', result.message);
            } : undefined}
          />
        )}
        {step === 5 && (
          <StepStorePolicies
            data={data}
            update={update}
            errors={errors}
            onValidate={() => setErrors(validateStepStorePolicies(data) as Record<string, string>)}
          />
        )}
        {step === 6 && (
          <StepAIInstructions
            data={data}
            update={update}
            errors={errors}
            testStatus={testStatus}
            testError={testError}
            testWarning={testWarning}
            onTest={runTest}
            isEdit={!!agentId}
            openaiSavedStatus={savedCredentials?.openai}
            lastTestedAt={lastTestedAt}
            openaiOverridesWorkspaceWarning={openaiOverridesWorkspaceWarning}
          />
        )}
        {step === 7 && (
          <StepReview
            data={data}
            errors={errors}
            testStatus={testStatus}
            testSource={testSource}
            onTest={runTest}
            onRunRequiredChecks={runRequiredLaunchChecks}
            launchReady={launchReady}
            isEdit={isEditMode}
            workspaceSummary={workspaceSummary}
            onJumpToField={jumpToFormField}
          />
        )}

        <div className="sticky bottom-0 z-10 -mx-1 mt-10 border-t border-border bg-background/95 px-1 py-6 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {step > 1 && (
                <button
                  type="button"
                  onClick={goBack}
                  className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
              >
                Cancel
              </button>
              {!agentId && (
                <button
                  type="button"
                  onClick={clearSavedDraft}
                  className="rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-foreground/10 focus:ring-offset-2"
                  title="Clear saved form and start fresh"
                >
                  Clear saved form
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
              {isEditMode ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleSubmit(false, false)}
                    disabled={submitting}
                    className={primaryBtn}
                    title="Keyboard: Ctrl+S (Windows) or Cmd+S (Mac)"
                  >
                    {submitting && submitKind === 'live' ? 'Saving…' : 'Save changes'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSubmit(false, true)}
                    disabled={submitting}
                    className={secondaryBtn}
                  >
                    {submitting && submitKind === 'live' ? 'Saving…' : 'Save & go to details'}
                  </button>
                  {step < 7 && (
                    <button type="button" onClick={goNext} className={nextBtn}>
                      Continue
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => handleSubmit(true)}
                    disabled={submitting}
                    className={secondaryBtn}
                    title="Saves to your account with minimal required fields. Invalid optional URLs are cleared server-side."
                  >
                    {submitting && submitKind === 'draft' ? 'Saving draft…' : 'Save as draft'}
                  </button>
                  {step === 7 ? (
                    <button
                      type="button"
                      onClick={() => handleSubmit(false)}
                      disabled={submitting || !launchReady}
                      className={primaryBtn}
                      title={!launchReady ? 'Complete launch readiness items on review first.' : undefined}
                    >
                      {submitting && submitKind === 'live' ? 'Launching…' : 'Launch agent'}
                    </button>
                  ) : (
                    <button type="button" onClick={goNext} className={nextBtn}>
                      Next
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          {isEditMode && (
            <p className="mt-3 text-center text-xs text-muted-foreground sm:text-right">
              Tip: <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">Ctrl</kbd>{' '}
              + <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">S</kbd> updates
              from any step.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}

function StepBasicInfo({
  data,
  update,
  errors,
  onValidate,
  isEdit,
  clients,
  stores,
  ownershipLoading,
  workspaceSummary,
  onRefreshStores,
}: {
  data: CreateAgentFormData;
  update: <K extends keyof CreateAgentFormData>(key: K, value: CreateAgentFormData[K]) => void;
  errors: Record<string, string>;
  onValidate: () => void;
  isEdit?: boolean;
  clients: ClientListItem[];
  stores: StoreListItem[];
  ownershipLoading: boolean;
  workspaceSummary: TenantIntegrationSummary | null;
  onRefreshStores: () => void;
}) {
  return (
    <div className="space-y-6">
      {!isEdit && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/90 px-4 py-3 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
          <p className="font-medium">Before you start</p>
          <p className="mt-1 text-xs">
            For a successful launch, configure integrations under Settings (or enter credentials in the steps below):
            Shopify, OpenAI, and Twilio. You can save a draft anytime.
          </p>
        </div>
      )}
      {!isEdit && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm space-y-3">
          <FormCheckbox
            id="useWorkspaceDefaults"
            label="Use saved workspace credentials from Settings → Integrations"
            checked={data.useWorkspaceDefaults}
            onChange={(v) => update('useWorkspaceDefaults', v)}
            helperText="When enabled, workspace integration flags are turned on for providers saved under Settings — secrets are never copied into this agent; runtime resolves them dynamically."
          />
          {data.useWorkspaceDefaults && workspaceSummary ? (
            <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
              <li>Shopify: {workspaceSummary.shopify.configured ? 'saved' : 'not saved yet'}</li>
              <li>Twilio: {workspaceSummary.twilio.configured ? 'saved' : 'not saved yet'}</li>
              <li>
                OpenAI: {workspaceSummary.openai.configured ? 'saved' : 'not saved (optional if the API server has OPENAI_API_KEY)'}
              </li>
              <li>ElevenLabs: {workspaceSummary.elevenlabs.configured ? 'saved' : 'not saved yet (optional)'}</li>
            </ul>
          ) : null}
        </div>
      )}
      <FormSection
        eyebrow="Step 1 of 7"
        title="Basic info"
        description="Who this agent is for and how we label it in your dashboard. You can change everything later."
      >
        <FormField
          id="clientId"
          label="Client"
          required
          helperText="The owning client account for this voice agent."
          error={errors.clientId}
        >
          <FormSelect
            id="clientId"
            value={data.clientId}
            disabled={ownershipLoading}
            onChange={(v) => update('clientId', v)}
            options={[
              { value: '', label: ownershipLoading ? 'Loading clients…' : 'Select client' },
              ...clients.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </FormField>
        <FormField
          id="storeId"
          label="Store"
          required
          helperText="Store profile to bind for this agent (created when you save Shopify under Settings → Integrations)."
          error={errors.storeId}
        >
          {!ownershipLoading && stores.length === 0 ? (
            <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/35 dark:text-amber-100">
              <p>
                No Shopify store connected yet. Go to Settings → Integrations → Shopify to connect your store.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/dashboard/settings/integrations/shopify"
                  className="inline-flex items-center rounded-lg bg-foreground px-4 py-2 text-xs font-medium text-background hover:opacity-90"
                >
                  Connect Shopify Store
                </Link>
                <button
                  type="button"
                  onClick={onRefreshStores}
                  className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2 text-xs font-medium hover:bg-muted"
                >
                  Refresh store list
                </button>
              </div>
            </div>
          ) : (
            <FormSelect
              id="storeId"
              value={data.storeId}
              disabled={ownershipLoading}
              onChange={(v) => update('storeId', v)}
              options={
                ownershipLoading
                  ? [{ value: '', label: 'Loading stores…' }]
                  : [
                      { value: '', label: 'Select store' },
                      ...stores.map((s) => ({ value: s.id, label: s.name })),
                    ]
              }
            />
          )}
          {!ownershipLoading && stores.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={onRefreshStores}
                className="font-medium text-violet-600 underline-offset-2 hover:underline dark:text-violet-400"
              >
                Refresh store list
              </button>{' '}
              if you just connected Shopify.
            </p>
          ) : null}
        </FormField>
        <FormField
          id="agentName"
          label="Agent display name"
          required
          helperText="A short internal name your team will see (for example “Main store line” or “Returns line”)."
          error={errors.agentName}
        >
          <FormInput
            id="agentName"
            value={data.agentName}
            onChange={(v) => update('agentName', v)}
            onBlur={onValidate}
            placeholder="e.g. Main store voice line"
          />
        </FormField>
        <FormField
          id="storeName"
          label="Business / store name"
          required
          helperText="The name of the business this agent represents on calls and in summaries."
          error={errors.storeName}
        >
          <FormInput
            id="storeName"
            value={data.storeName}
            onChange={(v) => update('storeName', v)}
            onBlur={onValidate}
            placeholder="e.g. Northwind Books"
          />
        </FormField>
        <FormField
          id="agentStatus"
          label="Launch status"
          helperText="Draft means you are still configuring. Active means the line is ready for traffic when Twilio is connected. Paused temporarily stops the agent from answering."
        >
          <FormSelect
            id="agentStatus"
            value={data.agentStatus}
            onChange={(v) => update('agentStatus', v as AgentStatus)}
            options={STATUS_OPTIONS}
          />
        </FormField>
        <FormField
          id="language"
          label="Primary language"
          helperText="Used for defaults and prompts. You can still describe other languages in your instructions later."
        >
          <FormSelect id="language" value={data.language} onChange={(v) => update('language', v)} options={LANGUAGE_OPTIONS} />
        </FormField>
        <FormField
          id="timezone"
          label="Store timezone"
          helperText="Used when callers ask about hours, cut‑offs, and “today” relative to your store."
        >
          <FormSelect id="timezone" value={data.timezone} onChange={(v) => update('timezone', v)} options={TIMEZONE_OPTIONS} />
        </FormField>
      </FormSection>

      <FormSection
        eyebrow="Contact & links"
        title="Storefront details"
        description="Optional but recommended. These details appear in customer-facing emails and help the agent stay accurate."
      >
        <FormField
          id="storeUrl"
          label="Public store URL"
          optional
          helperText="Your customer-facing website, including https://. Not the same as the Shopify admin domain (we will ask for that next)."
          error={errors.storeUrl}
        >
          <FormInput
            id="storeUrl"
            type="url"
            value={data.storeUrl}
            onChange={(v) => update('storeUrl', v)}
            onBlur={onValidate}
            placeholder="https://www.yourbrand.com"
          />
        </FormField>
        <FormField
          id="storeEmail"
          label="Store email"
          optional
          helperText="A general inbox for the business (orders, receipts, or hello@)."
          error={errors.storeEmail}
        >
          <FormInput
            id="storeEmail"
            type="email"
            value={data.storeEmail}
            onChange={(v) => update('storeEmail', v)}
            onBlur={onValidate}
            placeholder="hello@yourbrand.com"
          />
        </FormField>
        <FormField
          id="supportEmail"
          label="Support email"
          optional
          helperText="Shown when we need a support path (for example checkout email footers or follow-ups)."
          error={errors.supportEmail}
        >
          <FormInput
            id="supportEmail"
            type="email"
            value={data.supportEmail}
            onChange={(v) => update('supportEmail', v)}
            onBlur={onValidate}
            placeholder="support@yourbrand.com"
          />
        </FormField>
        <FormField
          id="supportPhone"
          label="Support phone"
          optional
          helperText="Optional public number for SMS or human handoff. Use E.164 format when possible (for example +1…)."
        >
          <FormInput id="supportPhone" value={data.supportPhone} onChange={(v) => update('supportPhone', v)} placeholder="+1 555 0100" />
        </FormField>
      </FormSection>
    </div>
  );
}

function TestBadge({ status }: { status: TestStatus }) {
  if (status === 'idle') return null;
  if (status === 'loading') {
    return <span className="text-xs text-muted-foreground">Testing…</span>;
  }
  if (status === 'success') {
    return <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-100">Connected</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 border border-red-100">Failed</span>;
}

function StepVoiceSettings({
  data,
  update,
  errors,
  testStatus,
  testError,
  testWarning,
  onTest,
  isEdit,
  openaiSavedStatus,
  elevenlabsSavedStatus,
  lastTestedAt,
  workspaceSummary,
  onValidate,
}: {
  data: CreateAgentFormData;
  update: <K extends keyof CreateAgentFormData>(key: K, value: CreateAgentFormData[K]) => void;
  errors: Record<string, string>;
  testStatus: Record<ConnectionTestTarget, TestStatus>;
  testError: Record<ConnectionTestTarget, string>;
  testWarning: Record<ConnectionTestTarget, string>;
  onTest: (target: ConnectionTestTarget) => void;
  isEdit?: boolean;
  openaiSavedStatus?: SavedCredentialStatus;
  elevenlabsSavedStatus?: SavedCredentialStatus;
  lastTestedAt?: string | null;
  workspaceSummary: TenantIntegrationSummary | null;
  onValidate: () => void;
}) {
  const workspaceElevenlabsConfigured = Boolean(workspaceSummary?.elevenlabs?.configured);
  const workspaceDefaultVoiceId = workspaceSummary?.elevenlabs?.defaultVoiceId ?? '';
  const workspaceDefaultModel = workspaceSummary?.elevenlabs?.defaultModel ?? '';
  const useSavedWorkspaceElevenlabs = workspaceElevenlabsConfigured && !data.elevenlabsApiKey?.trim();

  useEffect(() => {
    if (data.voiceProvider !== 'elevenlabs') return;
    if (!workspaceElevenlabsConfigured) return;
    if (!data.voiceId?.trim() && workspaceDefaultVoiceId) update('voiceId', workspaceDefaultVoiceId);
    if (!data.elevenlabsModel?.trim() && workspaceDefaultModel) update('elevenlabsModel', workspaceDefaultModel);
  }, [
    data.voiceProvider,
    data.voiceId,
    data.elevenlabsModel,
    workspaceElevenlabsConfigured,
    workspaceDefaultVoiceId,
    workspaceDefaultModel,
    update,
  ]);

  const toggleSupportedLanguage = (code: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...(data.supportedLanguages || []), code]))
      : (data.supportedLanguages || []).filter((v) => v !== code);
    update('supportedLanguages', next);
  };

  return (
    <div className="space-y-6">
      <FormSection
        eyebrow="Step 3 of 7"
        title="Voice settings"
        description="OpenAI runs intelligence + Shopify tools. ElevenLabs handles premium natural speech output for the caller."
      >
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-4 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-200">
          <p className="font-medium">Recommended setup</p>
          <p className="mt-1 text-xs">
            Use OpenAI for reasoning/tool-calling and ElevenLabs for voice playback quality. OpenAI voice remains available as a safe fallback/default.
          </p>
        </div>
        <div className="rounded-lg border border-amber-200/80 bg-amber-50/50 px-3 py-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/20">
          <p className="font-medium text-foreground">Credential source (per agent)</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Each toggle must be enabled to use workspace keys from Settings. Otherwise enter agent-specific API keys below.
            Production agents never use server .env provider keys unless single-tenant mode is enabled.
          </p>
          <div className="mt-3 space-y-2">
            <FormCheckbox
              id="useWorkspaceOpenai"
              label="Use workspace OpenAI API key"
              checked={data.useWorkspaceOpenai}
              onChange={(v) => update('useWorkspaceOpenai', v)}
            />
            <FormCheckbox
              id="useWorkspaceElevenlabs"
              label="Use workspace ElevenLabs API key"
              checked={data.useWorkspaceElevenlabs}
              onChange={(v) => update('useWorkspaceElevenlabs', v)}
            />
          </div>
        </div>
        <FormField
          id="voiceProvider"
          label="Voice provider"
          helperText="ElevenLabs gives the most human-like voice quality for sales calls."
        >
          <FormSelect id="voiceProvider" value={data.voiceProvider} onChange={(v) => update('voiceProvider', v)} options={VOICE_PROVIDER_OPTIONS} />
        </FormField>
        <FormField
          id="voiceId"
          label="ElevenLabs voice ID"
          helperText="Required for ElevenLabs. Use the exact voice ID from your ElevenLabs workspace."
          error={errors.voiceId}
        >
          <FormInput id="voiceId" value={data.voiceId} onChange={(v) => update('voiceId', v)} placeholder="e.g. 21m00Tcm4TlvDq8ikWAM" />
        </FormField>
        <FormField
          id="voiceNameLabel"
          label="Voice display label"
          optional
          helperText="Friendly name shown in the dashboard (does not affect synthesis)."
        >
          <FormInput id="voiceNameLabel" value={data.voiceNameLabel} onChange={(v) => update('voiceNameLabel', v)} placeholder="e.g. Rachel — warm sales" />
        </FormField>
        <FormField
          id="elevenlabsModel"
          label="ElevenLabs model"
          optional
          helperText="Model quality/latency profile for speech synthesis."
        >
          <FormSelect id="elevenlabsModel" value={data.elevenlabsModel} onChange={(v) => update('elevenlabsModel', v)} options={ELEVENLABS_MODEL_OPTIONS} />
        </FormField>
        <FormField
          id="voiceStyle"
          label="Speaking style notes"
          optional
          helperText="Good example: warm, natural, professional, slightly slow."
        >
          <FormInput id="voiceStyle" value={data.voiceStyle} onChange={(v) => update('voiceStyle', v)} placeholder="e.g. warm, natural, professional, slightly slow" />
        </FormField>

        <FormField
          id="languageMode"
          label="Multilingual mode"
          helperText="Auto-detect is recommended. Agent will automatically speak the caller's language."
        >
          <FormSelect id="languageMode" value={data.languageMode} onChange={(v) => update('languageMode', v as 'auto' | 'fixed')} options={LANGUAGE_MODE_OPTIONS} />
        </FormField>
        {data.languageMode === 'fixed' && (
          <FormField id="fixedLanguage" label="Fixed language" error={errors.fixedLanguage} helperText="Choose one language for all calls in this agent.">
            <FormSelect
              id="fixedLanguage"
              value={data.fixedLanguage}
              onChange={(v) => update('fixedLanguage', v)}
              options={[{ value: '', label: 'Select language' }, ...SUPPORTED_LANGUAGE_OPTIONS]}
            />
          </FormField>
        )}
        <FormField
          id="supportedLanguages"
          label="Supported languages"
          helperText="Caller can switch languages mid-call; the assistant follows automatically."
          error={errors.supportedLanguages}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SUPPORTED_LANGUAGE_OPTIONS.map((opt) => (
              <FormCheckbox
                key={opt.value}
                id={`supportedLanguage-${opt.value}`}
                label={opt.label}
                checked={Boolean(data.supportedLanguages?.includes(opt.value))}
                onChange={(checked) => toggleSupportedLanguage(opt.value, checked)}
              />
            ))}
          </div>
        </FormField>

        {(data.voiceProvider === 'openai' || data.voiceProvider === 'azure') && (
          <div className="rounded-xl border border-border bg-muted/15 p-4">
            <p className="text-sm font-medium text-foreground">OpenAI (voice)</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Used when your voice stack routes through OpenAI or Azure speech that relies on the same key.
            </p>
            {isEdit && openaiSavedStatus && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Saved key: <SavedBadge status={openaiSavedStatus} onClick={() => onTest('openai')} />
                {formatLastTested(lastTestedAt) && <span>Last tested: {formatLastTested(lastTestedAt)}</span>}
              </div>
            )}
            <div className="mt-3 space-y-3">
              <PasswordField
                id="openaiApiKeyVoice"
                label="OpenAI API key"
                value={data.openaiApiKey}
                onChange={(v) => update('openaiApiKey', v)}
                optional
                helperText="For security, saved keys are never shown. Leave blank to keep the existing key."
                error={errors.openaiApiKey}
                statusBadge={isEdit ? <SecretFieldBadge status={openaiSavedStatus} /> : null}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onTest('openai')}
                  disabled={testStatus.openai === 'loading'}
                  className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                >
                  Test OpenAI key
                </button>
                <TestBadge status={testStatus.openai} />
              </div>
              {testError.openai && (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {testError.openai}
                </p>
              )}
              {testWarning.openai && (
                <p className="text-sm text-amber-700 dark:text-amber-300" role="status">
                  {testWarning.openai}
                </p>
              )}
            </div>
          </div>
        )}

        {data.voiceProvider === 'elevenlabs' && (
          <div className="rounded-xl border border-border bg-muted/15 p-4">
            <p className="text-sm font-medium text-foreground">ElevenLabs</p>
            <p className="mt-1 text-xs text-muted-foreground">Used for premium, natural phone audio output only. OpenAI still handles intelligence/tool-calling.</p>
            {workspaceElevenlabsConfigured ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Workspace ElevenLabs is connected. You can use saved workspace key{workspaceDefaultVoiceId ? ` (default voice: ${workspaceDefaultVoiceId})` : ''} or override per agent below.
              </p>
            ) : null}
            {isEdit && elevenlabsSavedStatus && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Saved key: <SavedBadge status={elevenlabsSavedStatus} onClick={() => onTest('elevenlabs')} />
                {formatLastTested(lastTestedAt) && <span>Last tested: {formatLastTested(lastTestedAt)}</span>}
              </div>
            )}
            <div className="mt-3 space-y-3">
              <PasswordField
                id="elevenlabsApiKeyVoice"
                label="ElevenLabs API key"
                value={data.elevenlabsApiKey}
                onChange={(v) => update('elevenlabsApiKey', v)}
                optional
                helperText="Paste workspace key or agent-specific key. For security, saved keys are never shown. Leave blank to keep the existing key."
                error={errors.elevenlabsApiKey}
                statusBadge={isEdit ? <SecretFieldBadge status={elevenlabsSavedStatus} /> : null}
              />
              {workspaceElevenlabsConfigured ? (
                <FormCheckbox
                  id="useWorkspaceElevenlabs"
                  label="Use saved workspace ElevenLabs key"
                  checked={useSavedWorkspaceElevenlabs}
                  onChange={(checked) => {
                    if (checked) update('elevenlabsApiKey', '');
                  }}
                  helperText="When checked, runtime uses workspace key unless an agent key is provided."
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onTest('elevenlabs')}
                  disabled={testStatus.elevenlabs === 'loading'}
                  className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                >
                  Test ElevenLabs key + voice
                </button>
                <TestBadge status={testStatus.elevenlabs} />
              </div>
              {testError.elevenlabs && (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {testError.elevenlabs}
                </p>
              )}
              {testWarning.elevenlabs && (
                <p className="text-sm text-amber-700 dark:text-amber-300" role="status">
                  {testWarning.elevenlabs}
                </p>
              )}
            </div>
          </div>
        )}

        <FormField
          id="greetingMessage"
          label="Opening greeting"
          optional
          helperText="The very first thing callers hear. One or two short sentences work best."
          error={errors.greetingMessage}
        >
          <FormTextarea
            id="greetingMessage"
            value={data.greetingMessage}
            onChange={(v) => update('greetingMessage', v)}
            onBlur={onValidate}
            placeholder="Thanks for calling {store name}! I’m your virtual assistant—how can I help today?"
            rows={3}
          />
        </FormField>
        <FormField
          id="fallbackMessage"
          label="If the agent is unsure"
          optional
          helperText="Played when audio is unclear or the model needs the caller to repeat themselves."
          error={errors.fallbackMessage}
        >
          <FormTextarea
            id="fallbackMessage"
            value={data.fallbackMessage}
            onChange={(v) => update('fallbackMessage', v)}
            onBlur={onValidate}
            placeholder="I didn’t quite catch that—could you repeat it in a few words?"
            rows={2}
          />
        </FormField>
        <VoicePersonalitySection
          value={data.voicePersonality}
          onChange={(v) => update('voicePersonality', v)}
        />
      </FormSection>
    </div>
  );
}

/** Detect if value looks like a custom domain (not myshopify.com). */
function isCustomShopifyDomain(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  try {
    const url = s.match(/^https?:\/\//i) ? s : `https://${s}`;
    const host = new URL(url).hostname.toLowerCase();
    return !host.endsWith('.myshopify.com') && host !== 'myshopify.com';
  } catch {
    return false;
  }
}

function StepShopify({ data, update, errors, testStatus, testError, testWarning, onTest, isEdit, savedStatus, lastTestedAt, setupMode }: { data: CreateAgentFormData; update: <K extends keyof CreateAgentFormData>(key: K, value: CreateAgentFormData[K]) => void; errors: Record<string, string>; testStatus: Record<ConnectionTestTarget, TestStatus>; testError: Record<ConnectionTestTarget, string>; testWarning: Record<ConnectionTestTarget, string>; onTest: (target: ConnectionTestTarget) => void; isEdit?: boolean; savedStatus?: SavedCredentialStatus; lastTestedAt?: string | null; setupMode: 'simple' | 'advanced' }) {
  const hint = isEdit ? ' Leave blank to keep existing value.' : '';
  const showCustomDomainWarning = isCustomShopifyDomain(data.shopifyStoreUrl ?? '');
  return (
    <div className="space-y-6">
      <FormSection
        eyebrow="Step 2 of 7"
        title="Shopify connection"
        description={`Connect your Shopify admin so the agent can look up orders and catalog. Optional extras (app keys, FAQs) are under Advanced.${hint}`}
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/20 px-3 py-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={data.useWorkspaceShopify}
            onChange={(e) => update('useWorkspaceShopify', e.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium text-foreground">Use workspace Shopify integration</span>
            <span className="mt-0.5 block text-muted-foreground">
              When enabled, this agent uses the Shopify store configured under Settings → Integrations instead of
              agent-specific credentials below. Default is off so each agent can represent its own store.
            </span>
          </span>
        </label>
        {!data.useWorkspaceShopify && (
          <p className="text-sm text-muted-foreground">
            Agent-specific Shopify credentials (recommended for multi-store setups).
          </p>
        )}
        {isEdit && (
          <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200" role="note">
            <p>For security, saved credentials are never shown here. Leave credential fields blank to keep current values.</p>
            <div className="flex flex-wrap items-center gap-2">
              {savedStatus && <SavedBadge status={savedStatus} onClick={() => onTest('shopify')} />}
              {formatLastTested(lastTestedAt) && (
                <span className="text-xs text-muted-foreground">Last tested: {formatLastTested(lastTestedAt)}</span>
              )}
            </div>
          </div>
        )}
        <FormField
          id="shopifyApiVersion"
          label="Shopify API version"
          optional
          helperText="Admin API version (default 2024-10)."
          error={errors.shopifyApiVersion}
        >
          <FormInput
            id="shopifyApiVersion"
            type="text"
            value={data.shopifyApiVersion}
            onChange={(v) => update('shopifyApiVersion', v)}
            placeholder="2024-10"
          />
        </FormField>
        <FormField id="shopifyStoreUrl" label="Shopify myshopify domain" optional={data.useWorkspaceShopify} helperText="Paste any Shopify admin/store URL. We will automatically keep only the domain." error={errors.shopifyStoreUrl}>
          <FormInput
            id="shopifyStoreUrl"
            type="text"
            value={data.shopifyStoreUrl}
            onChange={(v) => update('shopifyStoreUrl', v)}
            onBlur={() => update('shopifyStoreUrl', normalizeShopifyDomain(data.shopifyStoreUrl))}
            placeholder="your-store.myshopify.com"
          />
        </FormField>
        <FormField
          id="shopifyStoreNumber"
          label="Shopify store number"
          optional
          helperText="Optional merchant-specific store number/ID if your operation tracks one."
          error={errors.shopifyStoreNumber}
        >
          <FormInput
            id="shopifyStoreNumber"
            type="text"
            value={data.shopifyStoreNumber}
            onChange={(v) => update('shopifyStoreNumber', v)}
            placeholder="e.g. 10234"
          />
        </FormField>
        {showCustomDomainWarning && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
            Use the Shopify myshopify.com domain from Shopify Admin.
          </p>
        )}
        <PasswordField
          id="shopifyAdminToken"
          label="Admin access token"
          value={data.shopifyAdminToken}
          onChange={(v) => update('shopifyAdminToken', v)}
          optional
          helperText="Create in Shopify Admin → Apps → Develop apps. For security, saved keys are never shown. Leave blank to keep the existing key."
          error={errors.shopifyAdminToken}
          statusBadge={isEdit ? <SecretFieldBadge status={savedStatus} /> : null}
        />
        <FieldHelpLinks
          links={[
            {
              href: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
              label: 'Shopify custom app tokens',
            },
            {
              href: 'https://admin.shopify.com/store',
              label: 'Open Shopify Admin',
            },
          ]}
        />
        {setupMode === 'advanced' && (
          <>
            <PasswordField
              id="shopifyApiKey"
              label="API key"
              value={data.shopifyApiKey}
              onChange={(v) => update('shopifyApiKey', v)}
              optional
              helperText="Optional. From your Shopify app credentials. For security, saved keys are never shown. Leave blank to keep the existing key."
              error={errors.shopifyApiKey}
              statusBadge={isEdit ? <SecretFieldBadge status={savedStatus} /> : null}
            />
            <PasswordField
              id="shopifyApiSecret"
              label="API secret"
              value={data.shopifyApiSecret}
              onChange={(v) => update('shopifyApiSecret', v)}
              optional
              helperText="Optional. Keep secret. For security, saved keys are never shown. Leave blank to keep the existing key."
              error={errors.shopifyApiSecret}
              statusBadge={isEdit ? <SecretFieldBadge status={savedStatus} /> : null}
            />
            <PasswordField
              id="webhookSecret"
              label="Webhook URL / secret"
              value={data.webhookSecret}
              onChange={(v) => update('webhookSecret', v)}
              optional
              helperText="Optional. For webhook notifications. For security, saved keys are never shown. Leave blank to keep the existing key."
              error={errors.webhookSecret}
              statusBadge={isEdit ? <SecretFieldBadge status={savedStatus} /> : null}
            />
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" onClick={() => onTest('shopify')} disabled={testStatus.shopify === 'loading'} aria-busy={testStatus.shopify === 'loading'} className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed">Test connection</button>
          <TestBadge status={testStatus.shopify} />
        </div>
        {testError.shopify && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
            {testError.shopify}
          </p>
        )}
        {testWarning.shopify && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300" role="status">
            {testWarning.shopify}
          </p>
        )}
      </FormSection>
      {setupMode === 'advanced' ? (
        <FormSection
          eyebrow="Knowledge (optional)"
          title="Knowledge base"
          description="Optional. Point the agent at FAQs, help articles, or docs—no SQL or database setup required."
        >
          <FormField
            id="knowledgeBaseSource"
            label="Knowledge source name or ID"
            optional
            helperText="A label or ID your team uses for this store’s FAQs or doc set (if your plan includes synced knowledge)."
          >
            <FormInput id="knowledgeBaseSource" value={data.knowledgeBaseSource} onChange={(v) => update('knowledgeBaseSource', v)} placeholder="e.g. store-help-center" />
          </FormField>
          <FormCheckbox
            id="knowledgeSyncEnabled"
            label="Keep knowledge in sync"
            checked={data.knowledgeSyncEnabled}
            onChange={(v) => update('knowledgeSyncEnabled', v)}
            helperText="When enabled, we refresh this content for the agent on a schedule (if your workspace supports it)."
          />
        </FormSection>
      ) : null}
    </div>
  );
}

function StepSalesBehavior({
  data,
  update,
  errors,
  testStatus,
  testError,
  testWarning,
  onTest,
  isEdit,
  agentId,
  savedStatus,
  resendSaved,
  workspaceEmailConfigured,
  lastTestedAt,
  onValidate,
  onTestEmail,
}: {
  data: CreateAgentFormData;
  update: <K extends keyof CreateAgentFormData>(key: K, value: CreateAgentFormData[K]) => void;
  errors: Record<string, string>;
  testStatus: Record<ConnectionTestTarget, TestStatus>;
  testError: Record<ConnectionTestTarget, string>;
  testWarning: Record<ConnectionTestTarget, string>;
  onTest: (target: ConnectionTestTarget) => void;
  isEdit?: boolean;
  agentId?: string;
  savedStatus?: SavedCredentialStatus;
  resendSaved?: boolean;
  workspaceEmailConfigured?: boolean;
  lastTestedAt?: string | null;
  onValidate: () => void;
  onTestEmail?: () => Promise<void>;
}) {
  const hint = isEdit ? ' Leave blank to keep existing value.' : '';
  return (
    <div className="space-y-6">
      <FormSection
        eyebrow="Step 4 of 7"
        title="Phone line (Twilio)"
        description={`Connect the phone number your customers dial.${hint}`}
      >
        {isEdit && (
          <div
            className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
            role="note"
          >
            <p>For security, saved credentials are hidden. Keep fields blank unless you want to replace them.</p>
            <div className="flex flex-wrap items-center gap-2">
              {savedStatus && <SavedBadge status={savedStatus} onClick={() => onTest('twilio')} />}
              {formatLastTested(lastTestedAt) && (
                <span className="text-xs text-muted-foreground">Last tested: {formatLastTested(lastTestedAt)}</span>
              )}
            </div>
          </div>
        )}
        <FormCheckbox
          id="useWorkspaceTwilio"
          label="Use workspace Twilio credentials (Settings → Integrations)"
          checked={data.useWorkspaceTwilio}
          onChange={(v) => update('useWorkspaceTwilio', v)}
          helperText="When enabled and agent fields are empty, Account SID and Auth Token resolve from workspace at runtime."
        />
        <PasswordField
          id="twilioAccountSid"
          label="Account SID"
          value={data.twilioAccountSid}
          onChange={(v) => update('twilioAccountSid', v)}
          optional
          helperText="Found on the main page of your Twilio console. For security, saved keys are never shown. Leave blank to keep the existing key."
          error={errors.twilioAccountSid}
          statusBadge={isEdit ? <SecretFieldBadge status={savedStatus} /> : null}
        />
        <FieldHelpLinks
          links={[
            { href: 'https://console.twilio.com/', label: 'Twilio Console' },
            { href: 'https://www.twilio.com/docs/iam/api-keys', label: 'Twilio credentials help' },
          ]}
        />
        <PasswordField
          id="twilioAuthToken"
          label="Auth token"
          value={data.twilioAuthToken}
          onChange={(v) => update('twilioAuthToken', v)}
          optional
          helperText="Treat this like a password—never share it in chat or email. For security, saved keys are never shown. Leave blank to keep the existing key."
          error={errors.twilioAuthToken}
          statusBadge={isEdit ? <SecretFieldBadge status={savedStatus} /> : null}
        />
        <FormField
          id="twilioPhoneNumber"
          label="Voice phone number"
          optional
          helperText={
            isEdit && data.twilioPhoneNumber?.trim()
              ? `Saved inbound number (normalized): ${normalizePhoneNumber(data.twilioPhoneNumber.trim())}. You can paste (251) 255-4549 or +12512554549 — we store E.164 and link it to this agent on save.`
              : 'The number customers dial. US/Canada 10-digit numbers get a leading +1. Examples: +12512554549, (251) 255-4549.'
          }
          error={errors.twilioPhoneNumber}
        >
          <FormInput
            id="twilioPhoneNumber"
            value={data.twilioPhoneNumber}
            onChange={(v) => update('twilioPhoneNumber', v)}
            onBlur={() =>
              update('twilioPhoneNumber', normalizePhoneNumber(data.twilioPhoneNumber.trim()))
            }
            placeholder="+1234567890"
          />
        </FormField>
        <FormField
          id="callRoutingMode"
          label="Call routing"
          helperText="Controls what happens before the AI joins (queue, voicemail, or straight to agent)."
        >
          <FormSelect id="callRoutingMode" value={data.callRoutingMode} onChange={(v) => update('callRoutingMode', v)} options={CALL_ROUTING_OPTIONS} />
        </FormField>
        <FormField
          id="incomingCallHandling"
          label="When the agent speaks"
          helperText="Fine-tune how quickly the assistant greets the caller once the line is connected."
        >
          <FormSelect
            id="incomingCallHandling"
            value={data.incomingCallHandling}
            onChange={(v) => update('incomingCallHandling', v)}
            options={INCOMING_CALL_OPTIONS}
          />
        </FormField>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onTest('twilio')}
            disabled={testStatus.twilio === 'loading'}
            className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Test Twilio credentials
          </button>
          <TestBadge status={testStatus.twilio} />
        </div>
        {testError.twilio && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
            {testError.twilio}
          </p>
        )}
        {testWarning.twilio && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300" role="status">
            {testWarning.twilio}
          </p>
        )}
      </FormSection>

      <FormSection
        eyebrow="Email & payment links"
        title="Resend checkout emails"
        description="Payment links are emailed after the customer confirms their address. Keys are stored encrypted and never shown again."
      >
        <FormCheckbox
          id="useWorkspaceEmail"
          label="Use workspace Resend integration when agent key is empty"
          checked={data.useWorkspaceEmail}
          onChange={(v) => update('useWorkspaceEmail', v)}
          helperText={
            workspaceEmailConfigured
              ? 'Workspace email is configured under Settings → Integrations → Email.'
              : 'No workspace email yet — add a per-agent Resend key or configure workspace email.'
          }
        />
        <PasswordField
          id="resendApiKey"
          label="Resend API key (this agent)"
          value={data.resendApiKey}
          onChange={(v) => update('resendApiKey', v)}
          optional
          helperText={
            isEdit
              ? 'Leave blank to keep the saved key. When workspace mode is on, an empty field uses workspace credentials.'
              : 'Optional if workspace email is configured.'
          }
          statusBadge={isEdit && resendSaved ? <span className="text-xs text-emerald-600">Saved</span> : null}
        />
        <FormField id="emailSenderName" label="Sender name" optional>
          <FormInput id="emailSenderName" value={data.emailSenderName} onChange={(v) => update('emailSenderName', v)} placeholder="e.g. Alpha Bookstore" />
        </FormField>
        <FormField id="emailSenderAddress" label="Sender email" error={errors.emailSenderAddress} helperText="Must be a verified domain in Resend.">
          <FormInput id="emailSenderAddress" value={data.emailSenderAddress} onChange={(v) => update('emailSenderAddress', v)} placeholder="orders@yourstore.com" />
        </FormField>
        <FormField id="emailReplyTo" label="Reply-to email" optional error={errors.emailReplyTo}>
          <FormInput id="emailReplyTo" value={data.emailReplyTo} onChange={(v) => update('emailReplyTo', v)} placeholder="support@yourstore.com" />
        </FormField>
        <FormField id="emailSubjectTemplate" label="Email subject template" optional helperText="Use {{storeName}} for the store name.">
          <FormInput id="emailSubjectTemplate" value={data.emailSubjectTemplate} onChange={(v) => update('emailSubjectTemplate', v)} />
        </FormField>
        <FormField id="paymentLinkEmailIntro" label="Payment link email intro" optional>
          <FormTextarea id="paymentLinkEmailIntro" value={data.paymentLinkEmailIntro} onChange={(v) => update('paymentLinkEmailIntro', v)} rows={3} placeholder="Optional opening paragraph before the standard checkout instructions." />
        </FormField>
        <FormField id="emailTestRecipient" label="Test email recipient" optional error={errors.emailTestRecipient}>
          <FormInput id="emailTestRecipient" value={data.emailTestRecipient} onChange={(v) => update('emailTestRecipient', v)} placeholder="you@company.com" />
        </FormField>
        {agentId && onTestEmail && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void onTestEmail()}
              className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              Send test email
            </button>
            <span className="text-xs text-muted-foreground">Uses this agent&apos;s sender and Resend config.</span>
          </div>
        )}
      </FormSection>

      <FormSection
        eyebrow="Checkout & handoff"
        title="Sales behavior"
        description="Tell the assistant how to behave when money, transfers, or sensitive topics come up."
      >
        <FormCheckbox
          id="askEmailBeforePaymentLink"
          label="Confirm email before sending checkout links"
          checked={data.askEmailBeforePaymentLink}
          onChange={(v) => update('askEmailBeforePaymentLink', v)}
          helperText="Adds a quick verbal double-check so links go to the right inbox."
        />
        <FormField
          id="checkoutMode"
          label="Checkout experience"
          helperText="Cart checkout keeps shoppers on your storefront. Draft invoice is better for phone orders that need review."
        >
          <FormSelect
            id="checkoutMode"
            value={data.checkoutMode}
            onChange={(v) => update('checkoutMode', v as 'cart' | 'draft_order')}
            options={[
              { value: 'cart', label: 'Storefront cart checkout' },
              { value: 'draft_order', label: 'Draft order / invoice' },
            ]}
          />
        </FormField>
        <FormField
          id="humanHandoffRules"
          label="When to involve a human"
          optional
          helperText="Plain-language cues for supervisors (for example VIP shoppers, legal threats, or custom quotes)."
        >
          <FormTextarea
            id="humanHandoffRules"
            value={data.humanHandoffRules}
            onChange={(v) => update('humanHandoffRules', v)}
            placeholder="Escalate angry callers, custom B2B quotes, or anything involving legal threats."
            rows={3}
          />
        </FormField>
        <FormField
          id="returnRefundBehavior"
          label="Returns & refunds script"
          optional
          helperText="What the agent should say before transferring to finance or support."
        >
          <FormTextarea
            id="returnRefundBehavior"
            value={data.returnRefundBehavior}
            onChange={(v) => update('returnRefundBehavior', v)}
            placeholder="Explain the policy window, then offer a warm transfer if they still need help."
            rows={3}
          />
        </FormField>
        <FormField
          id="orderStatusHandling"
          label="Order tracking playbook"
          optional
          helperText="How to answer “Where is my order?” using Shopify data."
        >
          <FormTextarea
            id="orderStatusHandling"
            value={data.orderStatusHandling}
            onChange={(v) => update('orderStatusHandling', v)}
            placeholder="Look up by email or order number, share carrier + ETA, set expectations if delayed."
            rows={3}
          />
        </FormField>
        <FormField
          id="outOfStockHandling"
          label="Out-of-stock talking points"
          optional
          helperText="Keeps disappointed shoppers engaged with alternatives or waitlists."
        >
          <FormTextarea
            id="outOfStockHandling"
            value={data.outOfStockHandling}
            onChange={(v) => update('outOfStockHandling', v)}
            placeholder="Apologize, suggest similar items, offer to notify them when it is back."
            rows={3}
          />
        </FormField>
        <FormCheckbox
          id="transferToHumanEnabled"
          label="Allow live team transfers"
          checked={data.transferToHumanEnabled}
          onChange={(v) => update('transferToHumanEnabled', v)}
          helperText="Turn off only if this line should stay fully automated."
        />
        <FormField
          id="escalationPhone"
          label="Escalation phone"
          optional
          helperText="Shown or spoken when the caller needs a human immediately."
          error={errors.escalationPhone}
        >
          <FormInput
            id="escalationPhone"
            value={data.escalationPhone}
            onChange={(v) => update('escalationPhone', v)}
            onBlur={() =>
              update('escalationPhone', normalizePhoneNumber(data.escalationPhone.trim()))
            }
            placeholder="+1234567890"
          />
        </FormField>
        <FormField
          id="escalationEmail"
          label="Escalation email"
          optional
          helperText="Used for follow-up summaries if a transfer fails or the shopper prefers email."
          error={errors.escalationEmail}
        >
          <FormInput
            id="escalationEmail"
            type="email"
            value={data.escalationEmail}
            onChange={(v) => update('escalationEmail', v)}
            onBlur={onValidate}
            placeholder="support@yourstore.com"
          />
        </FormField>
      </FormSection>
    </div>
  );
}

function StepStorePolicies({
  data,
  update,
  errors,
  onValidate,
}: {
  data: CreateAgentFormData;
  update: <K extends keyof CreateAgentFormData>(key: K, value: CreateAgentFormData[K]) => void;
  errors: Record<string, string>;
  onValidate: () => void;
}) {
  return (
    <FormSection
      eyebrow="Step 5 of 7"
      title="Store policies"
      description="Paste the policy language you already publish. The agent quotes this verbatim—keep it accurate."
    >
      <FormField
        id="shippingPolicy"
        label="Shipping policy"
        optional
        helperText="Processing times, carriers, and regions you ship to."
        error={errors.shippingPolicy}
      >
        <FormTextarea
          id="shippingPolicy"
          value={data.shippingPolicy}
          onChange={(v) => update('shippingPolicy', v)}
          onBlur={onValidate}
          placeholder="Standard orders ship within 24 hours..."
          rows={4}
        />
      </FormField>
      <FormField
        id="returnPolicy"
        label="Return policy"
        optional
        helperText="Windows, condition of items, and who pays return shipping."
        error={errors.returnPolicy}
      >
        <FormTextarea
          id="returnPolicy"
          value={data.returnPolicy}
          onChange={(v) => update('returnPolicy', v)}
          onBlur={onValidate}
          placeholder="Eligible returns within 30 days of delivery..."
          rows={4}
        />
      </FormField>
      <FormField
        id="exchangePolicy"
        label="Exchange policy"
        optional
        helperText="Explain how exchanges differ from returns (if applicable)."
        error={errors.exchangePolicy}
      >
        <FormTextarea
          id="exchangePolicy"
          value={data.exchangePolicy}
          onChange={(v) => update('exchangePolicy', v)}
          onBlur={onValidate}
          placeholder="Exchanges are honored for size swaps when inventory allows..."
          rows={4}
        />
      </FormField>
      <FormField
        id="deliveryNotes"
        label="Delivery notes"
        optional
        helperText="Holiday pauses, signature requirements, local pickup, etc."
        error={errors.deliveryNotes}
      >
        <FormTextarea
          id="deliveryNotes"
          value={data.deliveryNotes}
          onChange={(v) => update('deliveryNotes', v)}
          onBlur={onValidate}
          placeholder="We do not ship on Sundays; rural areas may add one transit day."
          rows={3}
        />
      </FormField>
    </FormSection>
  );
}

function StepAIInstructions({
  data,
  update,
  errors,
  testStatus,
  testError,
  testWarning,
  onTest,
  isEdit,
  openaiSavedStatus,
  lastTestedAt,
  openaiOverridesWorkspaceWarning,
}: {
  data: CreateAgentFormData;
  update: <K extends keyof CreateAgentFormData>(key: K, value: CreateAgentFormData[K]) => void;
  errors: Record<string, string>;
  testStatus: Record<ConnectionTestTarget, TestStatus>;
  testError: Record<ConnectionTestTarget, string>;
  testWarning: Record<ConnectionTestTarget, string>;
  onTest: (target: ConnectionTestTarget) => void;
  isEdit?: boolean;
  openaiSavedStatus?: SavedCredentialStatus;
  lastTestedAt?: string | null;
  openaiOverridesWorkspaceWarning?: boolean;
}) {
  return (
    <FormSection
      eyebrow="Step 6 of 7"
      title="AI instructions"
      description="This is the brain of your agent—what it is allowed to do, how it speaks, and when it must stop. Use a template, then make it yours."
    >
      <div className="rounded-xl border border-border bg-muted/20 p-4">
        <p className="text-sm font-medium text-foreground">LLM credentials</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Add your OpenAI API key for AI responses. For security, saved keys are never displayed; leave blank to keep the existing key.
        </p>
        {openaiOverridesWorkspaceWarning ? (
          <div
            className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100"
            role="status"
          >
            Agent key overrides workspace key. Live calls use the per-agent OpenAI key until you clear this field and
            save (empty = remove from agent secrets).
          </div>
        ) : null}
        {isEdit && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {openaiSavedStatus && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                OpenAI: <SavedBadge status={openaiSavedStatus} onClick={() => onTest('openai')} />
              </span>
            )}
            {formatLastTested(lastTestedAt) && (
              <span className="text-xs text-muted-foreground">Last tested: {formatLastTested(lastTestedAt)}</span>
            )}
          </div>
        )}
        <div className="mt-3 space-y-3">
          <PasswordField
            id="openaiApiKeyLlm"
            label="OpenAI API key"
            value={data.openaiApiKey}
            onChange={(v) => update('openaiApiKey', v)}
            optional
            helperText="Used by the LLM connection/runtime. For security, saved keys are never shown. Leave blank to keep the existing key."
            error={errors.openaiApiKey}
            statusBadge={isEdit ? <SecretFieldBadge status={openaiSavedStatus} /> : null}
          />
          <FieldHelpLinks
            links={[
              { href: 'https://platform.openai.com/api-keys', label: 'OpenAI API keys page' },
              { href: 'https://platform.openai.com/docs/quickstart', label: 'OpenAI quickstart' },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onTest('openai')}
              disabled={testStatus.openai === 'loading'}
              className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              Test OpenAI
            </button>
            <TestBadge status={testStatus.openai} />
          </div>
          {testError.openai && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {testError.openai}
            </p>
          )}
          {testWarning.openai && (
            <p className="text-sm text-amber-700 dark:text-amber-300" role="status">
              {testWarning.openai}
            </p>
          )}
        </div>
      </div>

      <FormField id="promptTemplate" label="Prompt template" optional helperText="Choose a starting point or start from scratch.">
        <FormSelect id="promptTemplate" value={data.promptTemplate} onChange={(v) => { update('promptTemplate', v); const t = PROMPT_TEMPLATES.find((x) => x.value === v); if (t?.prompt) update('systemPrompt', t.prompt); }} options={PROMPT_TEMPLATES.map((t) => ({ value: t.value, label: t.label }))} />
      </FormField>
      <FormField id="systemPrompt" label="Main instructions (identity & style)" optional helperText="Persona, tone, and how to speak — not long policies. Put refunds, shipping, hours, and FAQs in Knowledge Base; the agent retrieves them on calls." error={errors.systemPrompt}>
        <FormTextarea id="systemPrompt" value={data.systemPrompt} onChange={(v) => update('systemPrompt', v)} placeholder="You are a helpful voice assistant for the store. Answer questions about hours, orders, and products. Be polite and brief." rows={8} className="min-h-[180px] font-sans" />
      </FormField>
      <FormField id="agentRole" label="Agent role" optional helperText="e.g. Customer support agent for [Store Name].">
        <FormInput id="agentRole" value={data.agentRole} onChange={(v) => update('agentRole', v)} placeholder="e.g. Customer support agent for the store" />
      </FormField>
      <FormField id="agentGoal" label="Goal (one sentence)" optional helperText="What should this agent achieve?">
        <FormInput id="agentGoal" value={data.agentGoal} onChange={(v) => update('agentGoal', v)} placeholder="e.g. Help customers with orders, hours, and product info" />
      </FormField>
      <FormField id="toneOfVoice" label="Tone of voice" optional helperText="How the agent should sound.">
        <FormSelect id="toneOfVoice" value={data.toneOfVoice} onChange={(v) => update('toneOfVoice', v)} options={TONE_OPTIONS} />
      </FormField>
      <FormField id="openAiModel" label="OpenAI model" optional helperText="Model used for live call reasoning (e.g. gpt-4o-mini).">
        <FormInput id="openAiModel" value={data.openAiModel} onChange={(v) => update('openAiModel', v)} placeholder="gpt-4o-mini" />
      </FormField>
      <FormField id="allowedActions" label="Allowed actions" optional helperText="What the agent may do.">
        <FormTextarea id="allowedActions" value={data.allowedActions} onChange={(v) => update('allowedActions', v)} placeholder="Look up orders, check hours, answer FAQs" rows={2} />
      </FormField>
      <FormField id="restrictedActions" label="Forbidden actions" optional helperText="What the agent must never do.">
        <FormTextarea id="restrictedActions" value={data.restrictedActions} onChange={(v) => update('restrictedActions', v)} placeholder="Do not process payments or refunds." rows={2} />
      </FormField>
      <FormField id="escalationInstructions" label="Escalation rule" optional helperText="When to offer transfer to a human.">
        <FormTextarea id="escalationInstructions" value={data.escalationInstructions} onChange={(v) => update('escalationInstructions', v)} placeholder="Escalate when: refund requested, complaint, caller asks for a person." rows={2} />
      </FormField>
      <FormField id="forbiddenBehaviors" label="Forbidden behaviors" optional helperText="Safety rules the AI must never break.">
        <FormTextarea id="forbiddenBehaviors" value={data.forbiddenBehaviors} onChange={(v) => update('forbiddenBehaviors', v)} placeholder="Never invent price/stock/policy. Never collect raw card details." rows={2} />
      </FormField>
      <FormField id="escalationRules" label="Escalation rules (advanced)" optional helperText="Additional escalation policy lines.">
        <FormTextarea id="escalationRules" value={data.escalationRules} onChange={(v) => update('escalationRules', v)} placeholder="If uncertain, connect to human support." rows={2} />
      </FormField>
      <ToolPermissionsSection
        value={data.toolPermissions}
        onChange={(v) => update('toolPermissions', v)}
      />
      <div className="rounded-xl border border-border bg-muted/20 p-5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Preview: final instruction</p>
        <pre className="mt-4 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-background p-4 text-sm text-foreground font-sans border border-border">{composePreview(data)}</pre>
      </div>
    </FormSection>
  );
}

function composePreview(data: CreateAgentFormData): string {
  const parts: string[] = [];
  const languageMode = data.languageMode === 'fixed' ? `fixed (${data.fixedLanguage || 'not set'})` : 'auto-detect';
  const supportedLanguages = Array.isArray(data.supportedLanguages) ? data.supportedLanguages.join(', ') : '';
  if (data.agentRole?.trim()) {
    parts.push(`Role: ${data.agentRole.trim()}`);
  }
  if (data.agentGoal?.trim()) {
    parts.push(`Goal: ${data.agentGoal.trim()}`);
  }
  if (data.toneOfVoice?.trim()) {
    const label = TONE_OPTIONS.find((o) => o.value === data.toneOfVoice)?.label ?? data.toneOfVoice;
    parts.push(`Tone: ${label}`);
  }
  if (data.systemPrompt?.trim()) {
    parts.push(data.systemPrompt.trim());
  }
  if (data.allowedActions?.trim()) {
    parts.push(`Allowed: ${data.allowedActions.trim()}`);
  }
  if (data.restrictedActions?.trim()) {
    parts.push(`Not allowed: ${data.restrictedActions.trim()}`);
  }
  if (data.escalationInstructions?.trim()) {
    parts.push(`Escalate when: ${data.escalationInstructions.trim()}`);
  }
  parts.push(
    'Voice/runtime rules:',
    `- Voice provider strategy: ${data.voiceProvider || 'openai'}${data.voiceProvider === 'elevenlabs' ? ' with OpenAI fallback' : ''}.`,
    `- Language mode: ${languageMode}.`,
    `- Supported languages: ${supportedLanguages || 'en, ur, hi, ar, es, fr, de'}.`,
    '- Reply in caller language; switch if caller switches language.',
    '- Keep product names, SKUs, prices, and checkout URLs exact (never translated).',
    '- Ask for email before checkout, never collect card details, send secure payment link by email only.',
  );
  return parts.length ? parts.join('\n\n') : 'No instructions yet. Add a role, main instructions, or choose a template above.';
}

function StepReview({
  data,
  errors,
  isEdit,
  testStatus,
  testSource,
  onTest,
  onRunRequiredChecks,
  launchReady,
  workspaceSummary,
  onJumpToField,
}: {
  data: CreateAgentFormData;
  errors: Record<string, string>;
  isEdit?: boolean;
  testStatus?: Record<ConnectionTestTarget, TestStatus>;
  testSource?: Record<ConnectionTestTarget, string>;
  onTest?: (target: ConnectionTestTarget) => void;
  onRunRequiredChecks?: () => Promise<void> | void;
  launchReady?: boolean;
  workspaceSummary: TenantIntegrationSummary | null;
  onJumpToField?: (field: string) => void;
}) {
  const ws = workspaceSummary;
  const wsShopify = Boolean(ws?.shopify.configured);
  const wsTwilio = Boolean(ws?.twilio.configured);
  const wsOpenai = Boolean(ws?.openai.configured);
  const criticalItems = [
    {
      label: 'Shopify domain',
      ok: Boolean(data.shopifyStoreUrl.trim() || wsShopify),
      field: 'shopifyStoreUrl',
    },
    {
      label: 'Shopify token',
      ok: Boolean(data.shopifyAdminToken.trim() || wsShopify),
      field: 'shopifyAdminToken',
    },
    {
      label: 'OpenAI key',
      ok: Boolean(data.openaiApiKey.trim() || wsOpenai),
      field: 'openaiApiKey',
    },
    {
      label: 'Twilio SID',
      ok: Boolean(data.twilioAccountSid.trim() || wsTwilio),
      field: 'twilioAccountSid',
    },
    {
      label: 'Twilio token',
      ok: Boolean(data.twilioAuthToken.trim() || wsTwilio),
      field: 'twilioAuthToken',
    },
    {
      label: 'Twilio phone number',
      ok: Boolean(data.twilioPhoneNumber.trim() || wsTwilio),
      field: 'twilioPhoneNumber',
    },
  ];
  const missingCritical = criticalItems.filter((x) => !x.ok);

  return (
    <div className="space-y-8">
      <FormSection
        eyebrow="Step 7 of 7"
        title={isEdit ? 'Review & save' : 'Review & launch'}
        description={
          isEdit
            ? 'Run the credential checks one last time if anything changed, then press Update. You can still jump back to earlier steps.'
            : 'Everything below is what we will save. Run the tests if you want peace of mind, then create the agent or save a draft from the bar below.'
        }
      >
        {!isEdit && (
          <div className="space-y-2 rounded-xl border border-border bg-muted/15 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Launch readiness</p>
            <div className="flex flex-wrap gap-2">
              {criticalItems.map((item) =>
                item.ok ? (
                  <span
                    key={item.field}
                    className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700"
                  >
                    Ready: {item.label}
                  </span>
                ) : (
                  <button
                    key={item.field}
                    type="button"
                    onClick={() => onJumpToField?.(item.field)}
                    className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-left text-xs font-medium text-amber-800 underline-offset-2 hover:bg-amber-100 hover:underline focus:outline-none focus:ring-2 focus:ring-amber-400/40 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
                    title="Open the step and focus this field"
                  >
                    Missing: {item.label} — fix
                  </button>
                ),
              )}
            </div>
            {missingCritical.length > 0 ? (
              <p className="text-xs text-amber-900 dark:text-amber-200">
                Add the missing launch fields above. Save as draft if you are still collecting credentials.
              </p>
            ) : null}
          </div>
        )}
        {testStatus && onTest && (
          <div className="space-y-3 rounded-xl border border-border bg-muted/15 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Credential checks</p>
            <p className="text-xs text-muted-foreground">
              Optional but recommended. Tests use the same credential resolution as runtime: agent override, then workspace saved key, then env fallback (when available).
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onTest('shopify')}
                disabled={testStatus.shopify === 'loading'}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
              >
                Test Shopify
              </button>
              <button
                type="button"
                onClick={() => onTest('twilio')}
                disabled={testStatus.twilio === 'loading'}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
              >
                Test Twilio
              </button>
              <button
                type="button"
                onClick={() => onTest('openai')}
                disabled={testStatus.openai === 'loading'}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
              >
                Test OpenAI
              </button>
              <button
                type="button"
                onClick={() => onTest('elevenlabs')}
                disabled={testStatus.elevenlabs === 'loading'}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
              >
                Test ElevenLabs
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                void Promise.all([onTest('shopify'), onTest('twilio'), onTest('openai'), onTest('elevenlabs')]);
              }}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
            >
              Run all tests
            </button>
            {!isEdit && onRunRequiredChecks && (
              <button
                type="button"
                onClick={() => void onRunRequiredChecks()}
                disabled={!launchReady}
                className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 shadow-sm hover:bg-emerald-100 disabled:opacity-50"
                title={!launchReady ? 'Complete launch readiness items first.' : 'Runs Shopify, OpenAI, and Twilio checks in one click.'}
              >
                Run required launch checks
              </button>
            )}
            <div className="flex flex-wrap gap-2">
              {testStatus.shopify !== 'idle' && <span className="text-xs text-muted-foreground">Shopify: <TestBadge status={testStatus.shopify} /> {testSource?.shopify}</span>}
              {testStatus.twilio !== 'idle' && <span className="text-xs text-muted-foreground">Twilio: <TestBadge status={testStatus.twilio} /> {testSource?.twilio}</span>}
              {testStatus.openai !== 'idle' && <span className="text-xs text-muted-foreground">OpenAI: <TestBadge status={testStatus.openai} /> {testSource?.openai}</span>}
              {testStatus.elevenlabs !== 'idle' && <span className="text-xs text-muted-foreground">ElevenLabs: <TestBadge status={testStatus.elevenlabs} /> {testSource?.elevenlabs}</span>}
            </div>
          </div>
        )}
        {Object.keys(errors).length > 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/90 px-4 py-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            Some required fields are still invalid. Use the stepper or click a “Missing — fix” chip above to jump to the
            field.
          </div>
        ) : null}
        <AgentSummaryCard data={data} />
      </FormSection>
    </div>
  );
}

function AgentSummaryCard({ data }: { data: CreateAgentFormData }) {
  const basics = [
    { label: 'Agent name', value: data.agentName || '—' },
    { label: 'Store name', value: data.storeName || '—' },
    { label: 'Store URL', value: data.storeUrl || '—' },
    { label: 'Store email', value: data.storeEmail || '—' },
    { label: 'Support email', value: data.supportEmail || '—' },
    { label: 'Support phone', value: data.supportPhone || '—' },
    { label: 'Status', value: data.agentStatus },
    { label: 'Language', value: data.language },
    { label: 'Timezone', value: data.timezone },
  ];
  const shopify = [
    { label: 'Shopify admin domain', value: data.shopifyStoreUrl || '—' },
    { label: 'Shopify store number', value: data.shopifyStoreNumber || '—' },
    { label: 'Admin token', value: data.shopifyAdminToken ? '••••••••' : '—' },
    { label: 'Custom app API key', value: data.shopifyApiKey ? '••••••••' : '—' },
    { label: 'Custom app API secret', value: data.shopifyApiSecret ? '••••••••' : '—' },
    { label: 'Webhook secret / URL', value: data.webhookSecret ? 'Configured' : '—' },
  ];
  const knowledge = [
    { label: 'Knowledge source', value: data.knowledgeBaseSource || '—' },
    { label: 'Knowledge sync', value: data.knowledgeSyncEnabled ? 'On' : 'Off' },
  ];
  const voice = [
    { label: 'Voice provider', value: data.voiceProvider || '—' },
    { label: 'Voice ID', value: data.voiceId || '—' },
    { label: 'ElevenLabs model', value: data.elevenlabsModel || '—' },
    { label: 'Style notes', value: data.voiceStyle || '—' },
    { label: 'Language mode', value: data.languageMode === 'fixed' ? `Fixed (${data.fixedLanguage || '—'})` : 'Auto-detect' },
    { label: 'Supported languages', value: Array.isArray(data.supportedLanguages) && data.supportedLanguages.length ? data.supportedLanguages.join(', ') : '—' },
    {
      label: 'Greeting',
      value: data.greetingMessage ? (data.greetingMessage.length > 56 ? `${data.greetingMessage.slice(0, 56)}…` : data.greetingMessage) : '—',
    },
    { label: 'Fallback message', value: data.fallbackMessage ? 'Configured' : '—' },
  ];
  const sales = [
    { label: 'Twilio SID', value: data.twilioAccountSid ? '••••••••' : '—' },
    { label: 'Twilio auth token', value: data.twilioAuthToken ? '••••••••' : '—' },
    { label: 'Twilio number', value: data.twilioPhoneNumber || '—' },
    { label: 'Call routing', value: data.callRoutingMode || '—' },
    { label: 'Answer mode', value: data.incomingCallHandling || '—' },
    { label: 'Checkout mode', value: data.checkoutMode === 'draft_order' ? 'Draft invoice' : 'Storefront cart' },
    { label: 'Confirm email before checkout link', value: data.askEmailBeforePaymentLink ? 'Yes' : 'No' },
    { label: 'Transfers enabled', value: data.transferToHumanEnabled ? 'Yes' : 'No' },
    { label: 'Escalation phone', value: data.escalationPhone || '—' },
    { label: 'Escalation email', value: data.escalationEmail || '—' },
    { label: 'Returns playbook', value: data.returnRefundBehavior ? 'Configured' : '—' },
    { label: 'Order tracking playbook', value: data.orderStatusHandling ? 'Configured' : '—' },
    { label: 'Out of stock playbook', value: data.outOfStockHandling ? 'Configured' : '—' },
  ];
  const policies = [
    { label: 'Shipping policy', value: data.shippingPolicy ? 'Configured' : '—' },
    { label: 'Return policy', value: data.returnPolicy ? 'Configured' : '—' },
    { label: 'Exchange policy', value: data.exchangePolicy ? 'Configured' : '—' },
    { label: 'Delivery notes', value: data.deliveryNotes ? 'Configured' : '—' },
  ];
  const ai = [
    {
      label: 'Main instructions',
      value: data.systemPrompt ? (data.systemPrompt.length > 72 ? `${data.systemPrompt.slice(0, 72)}…` : data.systemPrompt) : '—',
    },
    { label: 'Role', value: data.agentRole || '—' },
    { label: 'Goal', value: data.agentGoal || '—' },
    {
      label: 'Tone',
      value: data.toneOfVoice ? TONE_OPTIONS.find((o) => o.value === data.toneOfVoice)?.label ?? data.toneOfVoice : '—',
    },
    { label: 'Allowed actions', value: data.allowedActions ? 'Configured' : '—' },
    { label: 'Forbidden actions', value: data.restrictedActions ? 'Configured' : '—' },
    { label: 'Escalation guidance', value: data.escalationInstructions ? 'Configured' : '—' },
    { label: 'Safety / forbidden behaviors', value: data.forbiddenBehaviors ? 'Configured' : '—' },
    { label: 'Escalation rules (advanced)', value: data.escalationRules ? 'Configured' : '—' },
  ];

  const section = (title: string, rows: { label: string; value: string }[]) => (
    <div key={title} className="border-b border-border last:border-0 p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      <dl className="mt-3 space-y-2.5">
        {rows.map(({ label, value }) => (
          <div key={label} className="flex justify-between gap-4 text-sm">
            <dt className="text-muted-foreground shrink-0">{label}</dt>
            <dd className="max-w-[60%] text-right font-medium text-foreground break-words normal-case">
              {String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-muted/15 shadow-inner">
      {section('Basic info', basics)}
      {section('Shopify & knowledge', [...shopify, ...knowledge])}
      {section('Voice', voice)}
      {section('Sales behavior', sales)}
      {section('Store policies', policies)}
      {section('AI instructions', ai)}
    </div>
  );
}

function WizardSuccessScreen({
  agentId,
  agentName,
  savedAsDraft,
  onViewAgent,
  onCreateAnother,
}: {
  agentId: string;
  agentName: string;
  savedAsDraft: boolean;
  onViewAgent: () => void;
  onCreateAnother: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg space-y-8 text-center">
      <div className="rounded-3xl border border-emerald-200 bg-gradient-to-b from-emerald-50 to-background p-10 shadow-sm dark:border-emerald-900/40 dark:from-emerald-950/30">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-2xl text-white shadow-md">
          ✓
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">
          {savedAsDraft ? 'Draft saved securely' : 'You are live-ready'}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {savedAsDraft
            ? 'We stored everything you entered so you can come back and finish setup whenever you are ready.'
            : 'Your Shopify voice agent is configured. Connect phone traffic when you are ready, or keep iterating safely in draft status.'}
        </p>
        <p className="mt-4 text-sm font-medium text-foreground">{agentName}</p>
        <p className="text-xs text-muted-foreground">Agent ID · {agentId}</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <button
          type="button"
          onClick={onViewAgent}
          className="rounded-xl border border-border bg-foreground px-6 py-3 text-sm font-semibold text-background shadow-sm hover:opacity-90"
        >
          Open agent dashboard
        </button>
        <button
          type="button"
          onClick={onCreateAnother}
          className="rounded-xl border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground shadow-sm hover:bg-muted"
        >
          Create another agent
        </button>
      </div>
    </div>
  );
}
