import {
  resolveCredentialPriority,
  type CredentialSource,
  type ResolvedCredential,
} from './credential-priority.util';
import { allowProviderEnvFallback } from './provider-env-fallback.util';

export type { CredentialSource, ResolvedCredential };
export { resolveCredentialPriority };

export type AgentSecretsSlice = {
  shopifyAdminToken?: string;
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  resendApiKey?: string;
};

/** Per-agent workspace opt-in flags (all default false in DB). */
export type AgentWorkspaceFlags = {
  useWorkspaceShopify?: boolean;
  useWorkspaceOpenai?: boolean;
  useWorkspaceElevenlabs?: boolean;
  useWorkspaceTwilio?: boolean;
  useWorkspaceEmail?: boolean;
};

export type WorkspaceIntegrationSlice = {
  shopifyStoreUrl?: string;
  shopifyAdminToken?: string;
  shopifyApiVersion?: string;
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  elevenlabsDefaultVoiceId?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  resendApiKey?: string;
  resendFromEmail?: string;
};

export type ResolvedShopifyConfig = {
  shopifyStoreUrl: string;
  shopifyAdminToken: string;
  shopifyApiVersion: string;
  source: Exclude<CredentialSource, 'env'> | 'env';
};

export type ResolvedOpenAiConfig = {
  apiKey: string;
  source: CredentialSource;
};

export type ResolvedElevenLabsConfig = {
  apiKey: string;
  voiceId?: string;
  source: CredentialSource;
};

export type ResolvedTwilioConfig = {
  accountSid: string;
  authToken: string;
  phoneNumber?: string;
  authSource: CredentialSource;
  sidSource: CredentialSource;
};

export type ResolvedEmailKeyConfig = {
  apiKey: string;
  source: CredentialSource;
};

export type ShopifyCredentialSummary = {
  configured: boolean;
  source: CredentialSource;
  useWorkspaceShopify: boolean;
  shopifyStoreUrlPresent: boolean;
};

export type CredentialSourcesSummary = {
  shopify: ShopifyCredentialSummary;
  openai: { source: CredentialSource; configured: boolean; useWorkspaceOpenai: boolean };
  elevenlabs: { source: CredentialSource; configured: boolean; useWorkspaceElevenlabs: boolean };
  twilio: { authSource: CredentialSource; configured: boolean; useWorkspaceTwilio: boolean };
  resend: { source: CredentialSource; configured: boolean; useWorkspaceEmail: boolean };
};

const DEFAULT_SHOPIFY_API_VERSION = '2024-10';

function trimOrUndef(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t || undefined;
}

function agentHasOwnShopify(agent: {
  shopifyStoreUrl?: string | null;
  secrets?: AgentSecretsSlice;
}): boolean {
  const url = trimOrUndef(agent.shopifyStoreUrl);
  const token = trimOrUndef(agent.secrets?.shopifyAdminToken);
  return Boolean(url && token);
}

function envOrUndef(key: string | undefined): string | undefined {
  if (!allowProviderEnvFallback()) return undefined;
  return trimOrUndef(key);
}

/** Last 4 chars for safe logs only. */
export function maskSecretTail(value: string | undefined): string | null {
  const t = value?.trim();
  if (!t) return null;
  if (t.length <= 4) return '****';
  return `****${t.slice(-4)}`;
}

/**
 * Shopify: agent store + token win. Workspace/env only when useWorkspaceShopify is true.
 */
export function resolveShopifyConfig(args: {
  agent: {
    shopifyStoreUrl?: string | null;
    secrets?: AgentSecretsSlice;
    useWorkspaceShopify?: boolean;
    shopifyApiVersion?: string | null;
  };
  workspace?: WorkspaceIntegrationSlice | null;
  env?: {
    shopifyStoreUrl?: string;
    shopifyAdminToken?: string;
    shopifyApiVersion?: string;
  };
}): ResolvedShopifyConfig | null {
  const useWorkspace = args.agent.useWorkspaceShopify === true;
  const apiVersion =
    trimOrUndef(args.agent.shopifyApiVersion) ||
    trimOrUndef(args.workspace?.shopifyApiVersion) ||
    envOrUndef(args.env?.shopifyApiVersion) ||
    DEFAULT_SHOPIFY_API_VERSION;

  if (agentHasOwnShopify(args.agent)) {
    return {
      shopifyStoreUrl: trimOrUndef(args.agent.shopifyStoreUrl)!,
      shopifyAdminToken: trimOrUndef(args.agent.secrets!.shopifyAdminToken)!,
      shopifyApiVersion: apiVersion,
      source: 'agent',
    };
  }

  if (!useWorkspace) return null;

  const urlResolved = resolveCredentialPriority(
    undefined,
    trimOrUndef(args.workspace?.shopifyStoreUrl),
    envOrUndef(args.env?.shopifyStoreUrl),
  );
  const tokenResolved = resolveCredentialPriority(
    undefined,
    trimOrUndef(args.workspace?.shopifyAdminToken),
    envOrUndef(args.env?.shopifyAdminToken),
  );
  if (!urlResolved.value || !tokenResolved.value) return null;

  const source: CredentialSource =
    tokenResolved.source === 'env' || urlResolved.source === 'env' ? 'env' : 'workspace';

  return {
    shopifyStoreUrl: urlResolved.value,
    shopifyAdminToken: tokenResolved.value,
    shopifyApiVersion: apiVersion,
    source,
  };
}

export function resolveShopifyConfigOrThrow(args: Parameters<typeof resolveShopifyConfig>[0]): ResolvedShopifyConfig {
  const resolved = resolveShopifyConfig(args);
  if (!resolved) {
    throw new Error('Shopify credentials missing for this agent.');
  }
  return resolved;
}

export function resolveOpenAiConfig(args: {
  agentSecrets?: AgentSecretsSlice;
  workspace?: WorkspaceIntegrationSlice | null;
  useWorkspaceOpenai?: boolean;
  envApiKey?: string;
}): ResolvedOpenAiConfig | null {
  const agentKey = trimOrUndef(args.agentSecrets?.openaiApiKey);
  if (agentKey) return { apiKey: agentKey, source: 'agent' };

  if (args.useWorkspaceOpenai !== true) return null;

  const resolved = resolveCredentialPriority(
    undefined,
    trimOrUndef(args.workspace?.openaiApiKey),
    envOrUndef(args.envApiKey),
  );
  if (!resolved.value || resolved.source === 'missing') return null;
  return { apiKey: resolved.value, source: resolved.source };
}

export function resolveElevenLabsConfig(args: {
  agentSecrets?: AgentSecretsSlice;
  workspace?: WorkspaceIntegrationSlice | null;
  useWorkspaceElevenlabs?: boolean;
  envApiKey?: string;
  agentVoiceId?: string | null;
}): ResolvedElevenLabsConfig | null {
  const agentKey = trimOrUndef(args.agentSecrets?.elevenlabsApiKey);
  if (agentKey) {
    const voiceId =
      trimOrUndef(args.agentVoiceId) || trimOrUndef(args.workspace?.elevenlabsDefaultVoiceId);
    return { apiKey: agentKey, source: 'agent', voiceId };
  }

  if (args.useWorkspaceElevenlabs !== true) return null;

  const keyResolved = resolveCredentialPriority(
    undefined,
    trimOrUndef(args.workspace?.elevenlabsApiKey),
    envOrUndef(args.envApiKey),
  );
  if (!keyResolved.value || keyResolved.source === 'missing') return null;
  const voiceId =
    trimOrUndef(args.agentVoiceId) || trimOrUndef(args.workspace?.elevenlabsDefaultVoiceId);
  return {
    apiKey: keyResolved.value,
    source: keyResolved.source,
    voiceId,
  };
}

export function resolveTwilioConfig(args: {
  agentSecrets?: AgentSecretsSlice;
  workspace?: WorkspaceIntegrationSlice | null;
  useWorkspaceTwilio?: boolean;
  agentPhoneNumber?: string | null;
}): ResolvedTwilioConfig | null {
  const agentSid = trimOrUndef(args.agentSecrets?.twilioAccountSid);
  const agentAuth = trimOrUndef(args.agentSecrets?.twilioAuthToken);
  if (agentSid && agentAuth) {
    const phone = trimOrUndef(args.agentPhoneNumber) || trimOrUndef(args.workspace?.twilioPhoneNumber);
    return {
      accountSid: agentSid,
      authToken: agentAuth,
      phoneNumber: phone,
      sidSource: 'agent',
      authSource: 'agent',
    };
  }

  if (args.useWorkspaceTwilio !== true) return null;

  const sidResolved = resolveCredentialPriority(undefined, trimOrUndef(args.workspace?.twilioAccountSid));
  const authResolved = resolveCredentialPriority(undefined, trimOrUndef(args.workspace?.twilioAuthToken));
  if (!sidResolved.value || !authResolved.value) return null;
  const phone =
    trimOrUndef(args.agentPhoneNumber) || trimOrUndef(args.workspace?.twilioPhoneNumber);
  return {
    accountSid: sidResolved.value,
    authToken: authResolved.value,
    phoneNumber: phone,
    sidSource: 'workspace',
    authSource: 'workspace',
  };
}

/** Resolve Twilio auth token only (webhook signature validation). */
export function resolveTwilioAuthToken(args: {
  agentSecrets?: AgentSecretsSlice;
  workspace?: WorkspaceIntegrationSlice | null;
  useWorkspaceTwilio?: boolean;
}): { token: string; source: CredentialSource } | null {
  const cfg = resolveTwilioConfig({
    agentSecrets: args.agentSecrets,
    workspace: args.workspace,
    useWorkspaceTwilio: args.useWorkspaceTwilio,
  });
  if (!cfg) return null;
  return { token: cfg.authToken, source: cfg.authSource };
}

export function resolveEmailKeyConfig(args: {
  agentSecrets?: AgentSecretsSlice;
  workspace?: WorkspaceIntegrationSlice | null;
  useWorkspaceEmail?: boolean;
  envApiKey?: string;
}): ResolvedEmailKeyConfig | null {
  const agentKey = trimOrUndef(args.agentSecrets?.resendApiKey);
  if (agentKey) return { apiKey: agentKey, source: 'agent' };

  if (args.useWorkspaceEmail !== true) return null;

  const keyResolved = resolveCredentialPriority(
    undefined,
    trimOrUndef(args.workspace?.resendApiKey),
    envOrUndef(args.envApiKey),
  );
  if (!keyResolved.value || keyResolved.source === 'missing') return null;
  return { apiKey: keyResolved.value, source: keyResolved.source };
}

export function resolveEmailFromAddress(args: {
  agentSenderAddress?: string | null;
  workspaceFromEmail?: string | null;
  envFromEmail?: string | null;
  useWorkspaceEmail?: boolean;
}): { address: string; source: CredentialSource } | null {
  const agentAddr = trimOrUndef(args.agentSenderAddress);
  if (agentAddr) return { address: agentAddr, source: 'agent' };

  if (args.useWorkspaceEmail !== true) return null;

  const resolved = resolveCredentialPriority(
    undefined,
    trimOrUndef(args.workspaceFromEmail),
    envOrUndef(args.envFromEmail ?? undefined),
  );
  if (!resolved.value || resolved.source === 'missing') return null;
  return { address: resolved.value, source: resolved.source };
}

/** Non-secret credential source summary for API/readiness/debug. */
export function buildCredentialSourcesSummary(args: {
  agent: AgentWorkspaceFlags & {
    shopifyStoreUrl?: string | null;
    secrets?: AgentSecretsSlice;
    voiceId?: string | null;
  };
  workspace?: WorkspaceIntegrationSlice | null;
  env?: {
    openaiApiKey?: string;
    elevenlabsApiKey?: string;
    resendApiKey?: string;
    shopifyStoreUrl?: string;
    shopifyAdminToken?: string;
    resendFromEmail?: string;
  };
}): CredentialSourcesSummary {
  const flags = args.agent;
  const shopifyResolved = resolveShopifyConfig({
    agent: flags,
    workspace: args.workspace,
    env: args.env,
  });
  const workspaceHasShopify = Boolean(
    trimOrUndef(args.workspace?.shopifyStoreUrl) && trimOrUndef(args.workspace?.shopifyAdminToken),
  );
  let shopifySource: CredentialSource = 'missing';
  if (shopifyResolved) {
    shopifySource = shopifyResolved.source;
  } else if (workspaceHasShopify && flags.useWorkspaceShopify !== true) {
    shopifySource = 'workspace';
  }

  const openai = resolveOpenAiConfig({
    agentSecrets: flags.secrets,
    workspace: args.workspace,
    useWorkspaceOpenai: flags.useWorkspaceOpenai,
    envApiKey: args.env?.openaiApiKey,
  });
  const eleven = resolveElevenLabsConfig({
    agentSecrets: flags.secrets,
    workspace: args.workspace,
    useWorkspaceElevenlabs: flags.useWorkspaceElevenlabs,
    envApiKey: args.env?.elevenlabsApiKey,
    agentVoiceId: flags.voiceId,
  });
  const twilio = resolveTwilioConfig({
    agentSecrets: flags.secrets,
    workspace: args.workspace,
    useWorkspaceTwilio: flags.useWorkspaceTwilio,
  });
  const resend = resolveEmailKeyConfig({
    agentSecrets: flags.secrets,
    workspace: args.workspace,
    useWorkspaceEmail: flags.useWorkspaceEmail,
    envApiKey: args.env?.resendApiKey,
  });

  return {
    shopify: {
      configured: Boolean(shopifyResolved),
      source: shopifySource,
      useWorkspaceShopify: flags.useWorkspaceShopify === true,
      shopifyStoreUrlPresent: Boolean(trimOrUndef(flags.shopifyStoreUrl)),
    },
    openai: {
      source: openai?.source ?? 'missing',
      configured: Boolean(openai),
      useWorkspaceOpenai: flags.useWorkspaceOpenai === true,
    },
    elevenlabs: {
      source: eleven?.source ?? 'missing',
      configured: Boolean(eleven),
      useWorkspaceElevenlabs: flags.useWorkspaceElevenlabs === true,
    },
    twilio: {
      authSource: twilio?.authSource ?? 'missing',
      configured: Boolean(twilio),
      useWorkspaceTwilio: flags.useWorkspaceTwilio === true,
    },
    resend: {
      source: resend?.source ?? 'missing',
      configured: Boolean(resend),
      useWorkspaceEmail: flags.useWorkspaceEmail === true,
    },
  };
}

export function logCredentialResolution(
  logger: { log: (msg: string) => void },
  provider: string,
  source: CredentialSource,
  agentId: string,
  tokenTail?: string | null,
): void {
  const tail = tokenTail ? ` tokenTail=${tokenTail}` : '';
  logger.log(`[credential-resolution] ${provider} source=${source} agentId=${agentId}${tail}`);
}
