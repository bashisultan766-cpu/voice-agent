'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  type AgentApi,
  type AgentReadinessResponse,
  type CredentialSourcesSummaryApi,
  type CredentialSourceApi,
  patchAgentCredentials,
  testAgentConnection,
  sendAgentTestEmail,
  type PatchAgentCredentialsPayload,
} from '@/lib/api/agents';
import { useToast } from '@/components/ui/Toast';
import { FormField, FormInput, FormCheckbox } from '@/components/agents/FormField';

type BlockId = 'shopify' | 'twilio' | 'openai' | 'elevenlabs' | 'email';

type AgentCredentialsPanelProps = {
  agentId: string;
  agent: AgentApi;
  credentialSources?: CredentialSourcesSummaryApi | null;
  onUpdated?: (readiness: AgentReadinessResponse, sources: CredentialSourcesSummaryApi) => void;
};

function sourceLabel(source: CredentialSourceApi): string {
  switch (source) {
    case 'agent':
      return 'Agent';
    case 'workspace':
      return 'Workspace';
    case 'env':
      return 'Server env';
    default:
      return 'Missing';
  }
}

function StatusBadge({ configured, source }: { configured: boolean; source: CredentialSourceApi }) {
  const cls = configured
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-amber-200 bg-amber-50 text-amber-900';
  return (
    <span className={`inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      <span>{configured ? 'Connected' : 'Not configured'}</span>
      <span className="text-[10px] font-normal opacity-80">· {sourceLabel(source)}</span>
    </span>
  );
}

function blockBusyKey(block: BlockId, action: 'save' | 'test'): string {
  return `${block}:${action}`;
}

export function AgentCredentialsPanel({
  agentId,
  agent,
  credentialSources: initialSources,
  onUpdated,
}: AgentCredentialsPanelProps) {
  const { addToast } = useToast();
  const [sources, setSources] = useState<CredentialSourcesSummaryApi | null>(initialSources ?? null);
  const [busy, setBusy] = useState<string | null>(null);

  const [useWorkspaceShopify, setUseWorkspaceShopify] = useState(
    (agent.useWorkspaceShopify as boolean) ?? false,
  );
  const [shopifyStoreUrl, setShopifyStoreUrl] = useState((agent.shopifyStoreUrl as string) ?? '');
  const [shopifyAdminToken, setShopifyAdminToken] = useState('');

  const [useWorkspaceTwilio, setUseWorkspaceTwilio] = useState((agent.useWorkspaceTwilio as boolean) ?? false);
  const [twilioAccountSid, setTwilioAccountSid] = useState('');
  const [twilioAuthToken, setTwilioAuthToken] = useState('');
  const [twilioPhoneNumber, setTwilioPhoneNumber] = useState((agent.twilioPhoneNumber as string) ?? '');

  const [useWorkspaceOpenai, setUseWorkspaceOpenai] = useState((agent.useWorkspaceOpenai as boolean) ?? false);
  const [openaiApiKey, setOpenaiApiKey] = useState('');

  const [useWorkspaceElevenlabs, setUseWorkspaceElevenlabs] = useState(
    (agent.useWorkspaceElevenlabs as boolean) ?? false,
  );
  const [elevenlabsApiKey, setElevenlabsApiKey] = useState('');
  const [voiceId, setVoiceId] = useState((agent.voiceId as string) ?? '');

  const [useWorkspaceEmail, setUseWorkspaceEmail] = useState((agent.useWorkspaceEmail as boolean) ?? false);
  const [resendApiKey, setResendApiKey] = useState('');
  const [emailSenderName, setEmailSenderName] = useState((agent.emailSenderName as string) ?? '');
  const [emailSenderAddress, setEmailSenderAddress] = useState((agent.emailSenderAddress as string) ?? '');
  const [paymentLinkEmailIntro, setPaymentLinkEmailIntro] = useState(
    (agent.paymentLinkEmailIntro as string) ?? '',
  );

  const shopifySource = useMemo(
    () =>
      sources?.shopify ?? {
        configured: agent.shopifyConnectionStatus === 'OK',
        source: (agent.shopifySource as CredentialSourceApi) ?? 'missing',
        useWorkspaceShopify,
        shopifyStoreUrlPresent: Boolean(shopifyStoreUrl.trim()),
      },
    [sources?.shopify, agent.shopifyConnectionStatus, agent.shopifySource, useWorkspaceShopify, shopifyStoreUrl],
  );
  const twilioSource = useMemo(
    () =>
      sources?.twilio ?? {
        configured: agent.twilioConnectionStatus === 'OK',
        authSource: 'missing' as CredentialSourceApi,
        useWorkspaceTwilio,
      },
    [sources?.twilio, agent.twilioConnectionStatus, useWorkspaceTwilio],
  );
  const openaiSource = useMemo(
    () =>
      sources?.openai ?? {
        configured: agent.openaiConnectionStatus === 'OK',
        source: 'missing' as CredentialSourceApi,
        useWorkspaceOpenai,
      },
    [sources?.openai, agent.openaiConnectionStatus, useWorkspaceOpenai],
  );
  const elevenSource = useMemo(
    () =>
      sources?.elevenlabs ?? {
        configured: agent.elevenlabsConnectionStatus === 'OK',
        source: 'missing' as CredentialSourceApi,
        useWorkspaceElevenlabs,
      },
    [sources?.elevenlabs, agent.elevenlabsConnectionStatus, useWorkspaceElevenlabs],
  );
  const resendSource = useMemo(
    () =>
      sources?.resend ?? {
        configured: agent.resendApiKeyConfigured === true,
        source: 'missing' as CredentialSourceApi,
        useWorkspaceEmail,
      },
    [sources?.resend, agent.resendApiKeyConfigured, useWorkspaceEmail],
  );

  const savedHint = useMemo(
    () => ({
      shopify: shopifySource.configured,
      twilio: twilioSource.configured,
      openai: openaiSource.configured,
      elevenlabs: elevenSource.configured,
      email: resendSource.configured && Boolean(emailSenderAddress.trim()),
    }),
    [shopifySource, twilioSource, openaiSource, elevenSource, resendSource, emailSenderAddress],
  );

  const runSave = useCallback(
    async (block: BlockId, payload: PatchAgentCredentialsPayload) => {
      setBusy(blockBusyKey(block, 'save'));
      try {
        const result = await patchAgentCredentials(agentId, payload);
        if (result.credentialSources) setSources(result.credentialSources);
        onUpdated?.(result.readiness, result.credentialSources);
        addToast('success', `${block.charAt(0).toUpperCase()}${block.slice(1)} credentials saved.`);
        if (block === 'shopify') setShopifyAdminToken('');
        if (block === 'twilio') {
          setTwilioAccountSid('');
          setTwilioAuthToken('');
        }
        if (block === 'openai') setOpenaiApiKey('');
        if (block === 'elevenlabs') setElevenlabsApiKey('');
        if (block === 'email') setResendApiKey('');
      } catch (e) {
        addToast('error', e instanceof Error ? e.message : 'Could not save credentials.');
      } finally {
        setBusy(null);
      }
    },
    [agentId, addToast, onUpdated],
  );

  const runTest = useCallback(
    async (block: BlockId) => {
      setBusy(blockBusyKey(block, 'test'));
      try {
        if (block === 'email') {
          const r = await sendAgentTestEmail(agentId, {
            toEmail: (agent.emailTestRecipient as string) || undefined,
          });
          if (r.success) addToast('success', r.message || 'Test email sent.');
          else addToast('error', r.message || 'Test email failed.');
          return;
        }
        const target =
          block === 'shopify'
            ? 'shopify'
            : block === 'twilio'
              ? 'twilio'
              : block === 'openai'
                ? 'openai'
                : 'elevenlabs';
        const creds: Partial<PatchAgentCredentialsPayload> = {};
        if (block === 'shopify') {
          if (shopifyStoreUrl.trim()) creds.shopifyStoreUrl = shopifyStoreUrl.trim();
          if (shopifyAdminToken.trim()) creds.shopifyAdminToken = shopifyAdminToken.trim();
          creds.useWorkspaceShopify = useWorkspaceShopify;
        } else if (block === 'twilio') {
          if (twilioAccountSid.trim()) creds.twilioAccountSid = twilioAccountSid.trim();
          if (twilioAuthToken.trim()) creds.twilioAuthToken = twilioAuthToken.trim();
          if (twilioPhoneNumber.trim()) creds.twilioPhoneNumber = twilioPhoneNumber.trim();
          creds.useWorkspaceTwilio = useWorkspaceTwilio;
        } else if (block === 'openai') {
          if (openaiApiKey.trim()) creds.openaiApiKey = openaiApiKey.trim();
          creds.useWorkspaceOpenai = useWorkspaceOpenai;
        } else {
          if (elevenlabsApiKey.trim()) creds.elevenlabsApiKey = elevenlabsApiKey.trim();
          if (voiceId.trim()) creds.voiceId = voiceId.trim();
          creds.useWorkspaceElevenlabs = useWorkspaceElevenlabs;
        }
        const result = await testAgentConnection(agentId, target, creds);
        if (result.success) {
          addToast('success', result.message || 'Connection test passed.');
        } else {
          addToast('error', result.message || 'Connection test failed.');
        }
      } catch (e) {
        addToast('error', e instanceof Error ? e.message : 'Connection test failed.');
      } finally {
        setBusy(null);
      }
    },
    [
      agentId,
      addToast,
      agent.emailTestRecipient,
      shopifyStoreUrl,
      shopifyAdminToken,
      useWorkspaceShopify,
      twilioAccountSid,
      twilioAuthToken,
      twilioPhoneNumber,
      useWorkspaceTwilio,
      openaiApiKey,
      useWorkspaceOpenai,
      elevenlabsApiKey,
      voiceId,
      useWorkspaceElevenlabs,
    ],
  );

  const blockActions = (block: BlockId, onSave: () => void) => (
    <div className="mt-4 flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy !== null}
        onClick={onSave}
        className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {busy === blockBusyKey(block, 'save') ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void runTest(block)}
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {busy === blockBusyKey(block, 'test') ? 'Testing…' : 'Test connection'}
      </button>
    </div>
  );

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Integration credentials</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Save each block separately. Secret fields stay empty when already stored — only type a new value to
            replace. Workspace defaults live under{' '}
            <Link href="/dashboard/settings/integrations" className="font-medium text-primary underline-offset-2 hover:underline">
              Settings → Integrations
            </Link>
            .
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Shopify */}
        <article className="min-w-0 rounded-lg border border-border/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">Shopify</h3>
            <StatusBadge
              configured={shopifySource.configured}
              source={shopifySource.source === 'missing' && shopifySource.useWorkspaceShopify ? 'workspace' : shopifySource.source}
            />
          </div>
          {savedHint.shopify ? (
            <p className="mt-2 text-xs text-muted-foreground">Admin token saved (hidden).</p>
          ) : null}
          <div className="mt-3 space-y-3">
            <FormCheckbox
              id="cred-use-ws-shopify"
              label="Use workspace Shopify (Settings)"
              checked={useWorkspaceShopify}
              onChange={setUseWorkspaceShopify}
            />
            <FormField id="cred-shopify-url" label="Shop domain" helperText="e.g. your-store.myshopify.com">
              <FormInput
                id="cred-shopify-url"
                value={shopifyStoreUrl}
                onChange={setShopifyStoreUrl}
                placeholder="your-store.myshopify.com"
                autoComplete="off"
                className="font-mono text-sm"
              />
            </FormField>
            {!useWorkspaceShopify ? (
              <FormField id="cred-shopify-token" label="Admin API access token" helperText="Leave blank to keep saved token.">
                <FormInput
                  id="cred-shopify-token"
                  type="password"
                  value={shopifyAdminToken}
                  onChange={setShopifyAdminToken}
                  placeholder={savedHint.shopify ? 'Saved — type to replace' : 'shpat_…'}
                  autoComplete="new-password"
                  className="font-mono text-sm"
                />
              </FormField>
            ) : null}
          </div>
          {blockActions('shopify', () =>
            void runSave('shopify', {
              useWorkspaceShopify,
              shopifyStoreUrl: shopifyStoreUrl.trim() || undefined,
              ...(shopifyAdminToken.trim() ? { shopifyAdminToken: shopifyAdminToken.trim() } : {}),
            }),
          )}
        </article>

        {/* Twilio */}
        <article className="min-w-0 rounded-lg border border-border/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">Twilio</h3>
            <StatusBadge configured={twilioSource.configured} source={twilioSource.authSource} />
          </div>
          {savedHint.twilio ? (
            <p className="mt-2 text-xs text-muted-foreground">Auth credentials saved (hidden).</p>
          ) : null}
          <div className="mt-3 space-y-3">
            <FormCheckbox
              id="cred-use-ws-twilio"
              label="Use workspace Twilio (Settings)"
              checked={useWorkspaceTwilio}
              onChange={setUseWorkspaceTwilio}
            />
            {!useWorkspaceTwilio ? (
              <>
                <FormField id="cred-twilio-sid" label="Account SID">
                  <FormInput
                    id="cred-twilio-sid"
                    value={twilioAccountSid}
                    onChange={setTwilioAccountSid}
                    placeholder={savedHint.twilio ? 'Saved — type to replace' : 'AC…'}
                    autoComplete="off"
                    className="font-mono text-sm break-all"
                  />
                </FormField>
                <FormField id="cred-twilio-token" label="Auth token">
                  <FormInput
                    id="cred-twilio-token"
                    type="password"
                    value={twilioAuthToken}
                    onChange={setTwilioAuthToken}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    className="font-mono text-sm"
                  />
                </FormField>
              </>
            ) : null}
            <FormField id="cred-twilio-phone" label="Voice phone number (E.164)">
              <FormInput
                id="cred-twilio-phone"
                value={twilioPhoneNumber}
                onChange={setTwilioPhoneNumber}
                placeholder="+1…"
                className="font-mono text-sm"
              />
            </FormField>
          </div>
          {blockActions('twilio', () =>
            void runSave('twilio', {
              useWorkspaceTwilio,
              twilioPhoneNumber: twilioPhoneNumber.trim() || undefined,
              ...(twilioAccountSid.trim() ? { twilioAccountSid: twilioAccountSid.trim() } : {}),
              ...(twilioAuthToken.trim() ? { twilioAuthToken: twilioAuthToken.trim() } : {}),
            }),
          )}
        </article>

        {/* OpenAI */}
        <article className="min-w-0 rounded-lg border border-border/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">OpenAI</h3>
            <StatusBadge configured={openaiSource.configured} source={openaiSource.source} />
          </div>
          {savedHint.openai ? (
            <p className="mt-2 text-xs text-muted-foreground">API key saved (hidden).</p>
          ) : null}
          <div className="mt-3 space-y-3">
            <FormCheckbox
              id="cred-use-ws-openai"
              label="Use workspace OpenAI (Settings)"
              checked={useWorkspaceOpenai}
              onChange={setUseWorkspaceOpenai}
            />
            {!useWorkspaceOpenai ? (
              <FormField id="cred-openai-key" label="API key">
                <FormInput
                  id="cred-openai-key"
                  type="password"
                  value={openaiApiKey}
                  onChange={setOpenaiApiKey}
                  placeholder={savedHint.openai ? 'Saved — type to replace' : 'sk-…'}
                  autoComplete="new-password"
                  className="font-mono text-sm"
                />
              </FormField>
            ) : null}
          </div>
          {blockActions('openai', () =>
            void runSave('openai', {
              useWorkspaceOpenai,
              ...(openaiApiKey.trim() ? { openaiApiKey: openaiApiKey.trim() } : {}),
            }),
          )}
        </article>

        {/* ElevenLabs */}
        <article className="min-w-0 rounded-lg border border-border/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">ElevenLabs</h3>
            <StatusBadge configured={elevenSource.configured} source={elevenSource.source} />
          </div>
          {savedHint.elevenlabs ? (
            <p className="mt-2 text-xs text-muted-foreground">API key saved (hidden).</p>
          ) : null}
          <div className="mt-3 space-y-3">
            <FormCheckbox
              id="cred-use-ws-eleven"
              label="Use workspace ElevenLabs (Settings)"
              checked={useWorkspaceElevenlabs}
              onChange={setUseWorkspaceElevenlabs}
            />
            {!useWorkspaceElevenlabs ? (
              <FormField id="cred-eleven-key" label="API key">
                <FormInput
                  id="cred-eleven-key"
                  type="password"
                  value={elevenlabsApiKey}
                  onChange={setElevenlabsApiKey}
                  placeholder={savedHint.elevenlabs ? 'Saved — type to replace' : 'xi-…'}
                  autoComplete="new-password"
                  className="font-mono text-sm"
                />
              </FormField>
            ) : null}
            <FormField id="cred-voice-id" label="Voice ID">
              <FormInput
                id="cred-voice-id"
                value={voiceId}
                onChange={setVoiceId}
                placeholder="ElevenLabs voice id"
                className="font-mono text-sm break-all"
              />
            </FormField>
          </div>
          {blockActions('elevenlabs', () =>
            void runSave('elevenlabs', {
              useWorkspaceElevenlabs,
              voiceId: voiceId.trim() || undefined,
              ...(elevenlabsApiKey.trim() ? { elevenlabsApiKey: elevenlabsApiKey.trim() } : {}),
            }),
          )}
        </article>

        {/* Email / Resend — full width */}
        <article className="min-w-0 rounded-lg border border-border/80 p-4 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">Email (Resend) — payment links</h3>
            <StatusBadge configured={resendSource.configured} source={resendSource.source} />
          </div>
          {agent.resendApiKeyConfigured === true ? (
            <p className="mt-2 text-xs text-muted-foreground">Resend API key saved (hidden).</p>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <FormCheckbox
              id="cred-use-ws-email"
              label="Use workspace Resend (Settings)"
              checked={useWorkspaceEmail}
              onChange={setUseWorkspaceEmail}
            />
            {!useWorkspaceEmail ? (
              <FormField id="cred-resend-key" label="Resend API key" helperText="Leave blank to keep saved key.">
                <FormInput
                  id="cred-resend-key"
                  type="password"
                  value={resendApiKey}
                  onChange={setResendApiKey}
                  placeholder={agent.resendApiKeyConfigured ? 'Saved — type to replace' : 're_…'}
                  autoComplete="new-password"
                  className="font-mono text-sm"
                />
              </FormField>
            ) : (
              <div />
            )}
            <FormField id="cred-sender-name" label="Sender name">
              <FormInput
                id="cred-sender-name"
                value={emailSenderName}
                onChange={setEmailSenderName}
                placeholder="Your Bookstore"
              />
            </FormField>
            <FormField id="cred-from-email" label="From email">
              <FormInput
                id="cred-from-email"
                type="email"
                value={emailSenderAddress}
                onChange={setEmailSenderAddress}
                placeholder="orders@yourdomain.com"
                className="font-mono text-sm"
              />
            </FormField>
            <div className="sm:col-span-2">
              <FormField
                id="cred-payment-intro"
                label="Payment link email intro"
                helperText="Optional custom intro in checkout emails."
              >
                <textarea
                  id="cred-payment-intro"
                  value={paymentLinkEmailIntro}
                  onChange={(e) => setPaymentLinkEmailIntro(e.target.value)}
                  rows={3}
                  className="w-full max-w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm"
                />
              </FormField>
            </div>
          </div>
          {blockActions('email', () =>
            void runSave('email', {
              useWorkspaceEmail,
              emailSenderName: emailSenderName.trim() || undefined,
              emailSenderAddress: emailSenderAddress.trim() || undefined,
              paymentLinkEmailIntro: paymentLinkEmailIntro.trim() || undefined,
              ...(resendApiKey.trim() ? { resendApiKey: resendApiKey.trim() } : {}),
            }),
          )}
        </article>
      </div>
    </section>
  );
}
