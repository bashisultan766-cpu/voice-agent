import {
  resolveCredentialPriority,
  type CredentialSource,
  type ResolvedCredential,
} from './credential-priority.util';

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
  openai: { source: CredentialSource; configured: boolean };
  elevenlabs: { source: CredentialSource; configured: boolean };
  twilio: { authSource: CredentialSource; configured: boolean };
  resend: { source: CredentialSource; configured: boolean };
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

/** Last 4 chars for safe logs only. */
export function maskSecretTail(value: string | undefined): string | null {
  const t = value?.trim();
  if (!t) return null;
  if (t.length <= 4) return '****';
  return `****${t.slice(-4)}`;
}

/**
 * Shopify: agent store + token win. Workspace/env only when useWorkspaceShopify is true.
 * Never use workspace/env when the agent has its own Shopify credentials.
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
    trimOrUndef(args.env?.shopifyApiVersion) ||
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
    trimOrUndef(args.env?.shopifyStoreUrl),
  );
  const tokenResolved = resolveCredentialPriority(
    undefined,
    trimOrUndef(args.workspace?.shopifyAdminToken),
    trimOrUndef(args.env?.shopifyAdminToken),
  );
  if (!urlResolved.value || !tokenResolved.value) return null;

  const source: CredentialSource =
    tokenResolved.source === 'env' || urlResolved.source === 'env'
      ? 'env'
      : 'workspace';

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
  envApiKey?: string;
}): ResolvedOpenAiConfig | null {
  const resolved = resolveCredentialPriority(
    trimOrUndef(args.agentSecrets?.openaiApiKey),
    trimOrUndef(args.workspace?.openaiApiKey),
    trimOrUndef(args.envApiKey),
  );
  if (!resolved.value || resolved.source === 'missing') return null;
  return { apiKey: resolved.value, source: resolved.source };
}

export function resolveElevenLabsConfig(args: {
  agentSecrets?: AgentSecretsSlice;
  workspace?: WorkspaceIntegrationSlice | null;
  envApiKey?: string;
  agentVoiceId?: string | null;
}): ResolvedElevenLabsConfig | null {
  const keyResolved = resolveCredentialPriority(
    trimOrUndef(args.agentSecrets?.elevenlabsApiKey),
    trimOrUndef(args.workspace?.elevenlabsApiKey),
    trimOrUndef(args.envApiKey),
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
  agentPhoneNumber?: string | null;
}): ResolvedTwilioConfig | null {
  const sidResolved = resolveCredentialPriority(
    trimOrUndef(args.agentSecrets?.twilioAccountSid),
    trimOrUndef(args.workspace?.twilioAccountSid),
  );
  const authResolved = resolveCredentialPriority(
    trimOrUndef(args.agentSecrets?.twilioAuthToken),
    trimOrUndef(args.workspace?.twilioAuthToken),
  );
  if (!sidResolved.value || !authResolved.value) return null;
  const phone =
    trimOrUndef(args.agentPhoneNumber) || trimOrUndef(args.workspace?.twilioPhoneNumber);
  return {
    accountSid: sidResolved.value,
    authToken: authResolved.value,
    phoneNumber: phone,
    sidSource: sidResolved.source,
    authSource: authResolved.source,
  };
}

export function resolveEmailKeyConfig(args: {
  agentSecrets?: AgentSecretsSlice;
  workspace?: WorkspaceIntegrationSlice | null;
  envApiKey?: string;
  useWorkspaceEmail?: boolean;
  /** When false, RESEND_API_KEY env is never used (production default). */
  allowEnvFallback?: boolean;
}): ResolvedEmailKeyConfig | null {
  const agentKey = trimOrUndef(args.agentSecrets?.resendApiKey);
  if (agentKey) {
    return { apiKey: agentKey, source: 'agent' };
  }

  const allowEnv =
    args.allowEnvFallback ?? (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production');
  const envKey = allowEnv ? trimOrUndef(args.envApiKey) : undefined;
  const useWorkspace = args.useWorkspaceEmail !== false;

  if (useWorkspace) {
    const keyResolved = resolveCredentialPriority(
      undefined,
      trimOrUndef(args.workspace?.resendApiKey),
      envKey,
    );
    if (!keyResolved.value || keyResolved.source === 'missing') return null;
    return { apiKey: keyResolved.value, source: keyResolved.source };
  }

  if (envKey) {
    return { apiKey: envKey, source: 'env' };
  }
  return null;
}

/** Non-secret credential source summary for API/readiness/debug. */
export function buildCredentialSourcesSummary(args: {
  agent: {
    shopifyStoreUrl?: string | null;
    secrets?: AgentSecretsSlice;
    useWorkspaceShopify?: boolean;
    useWorkspaceEmail?: boolean;
    voiceId?: string | null;
  };
  workspace?: WorkspaceIntegrationSlice | null;
  env?: {
    openaiApiKey?: string;
    elevenlabsApiKey?: string;
    resendApiKey?: string;
    shopifyStoreUrl?: string;
    shopifyAdminToken?: string;
  };
}): CredentialSourcesSummary {
  const shopifyResolved = resolveShopifyConfig({
    agent: args.agent,
    workspace: args.workspace,
    env: args.env,
  });
  const workspaceHasShopify = Boolean(
    trimOrUndef(args.workspace?.shopifyStoreUrl) && trimOrUndef(args.workspace?.shopifyAdminToken),
  );
  let shopifySource: CredentialSource = 'missing';
  if (shopifyResolved) {
    shopifySource = shopifyResolved.source;
  } else if (workspaceHasShopify && args.agent.useWorkspaceShopify !== true) {
    /** Workspace has Shopify but agent did not opt in — report as workspace (blocked) for readiness UI. */
    shopifySource = 'workspace';
  }

  const openai = resolveOpenAiConfig({
    agentSecrets: args.agent.secrets,
    workspace: args.workspace,
    envApiKey: args.env?.openaiApiKey,
  });
  const eleven = resolveElevenLabsConfig({
    agentSecrets: args.agent.secrets,
    workspace: args.workspace,
    envApiKey: args.env?.elevenlabsApiKey,
    agentVoiceId: args.agent.voiceId,
  });
  const twilio = resolveTwilioConfig({
    agentSecrets: args.agent.secrets,
    workspace: args.workspace,
  });
  const allowEnvResend =
    typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';
  const resend = resolveEmailKeyConfig({
    agentSecrets: args.agent.secrets,
    workspace: args.workspace,
    envApiKey: args.env?.resendApiKey,
    useWorkspaceEmail: args.agent.useWorkspaceEmail,
    allowEnvFallback: allowEnvResend,
  });

  return {
    shopify: {
      configured: Boolean(shopifyResolved),
      source: shopifySource,
      useWorkspaceShopify: args.agent.useWorkspaceShopify === true,
      shopifyStoreUrlPresent: Boolean(trimOrUndef(args.agent.shopifyStoreUrl)),
    },
    openai: {
      source: openai?.source ?? 'missing',
      configured: Boolean(openai),
    },
    elevenlabs: {
      source: eleven?.source ?? 'missing',
      configured: Boolean(eleven),
    },
    twilio: {
      authSource: twilio?.authSource ?? 'missing',
      configured: Boolean(twilio),
    },
    resend: {
      source: resend?.source ?? 'missing',
      configured: Boolean(resend),
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
