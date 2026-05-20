/**
 * Voice runtime credential precedence (documented — keep in sync with SessionContextService and ops docs):
 *
 * OpenAI API key:
 * 1) Agent secretsEnc JSON `openaiApiKey` when non-empty after decrypt
 * 2) TenantIntegration.openaiApiKeyEnc when decrypt succeeds
 * 3) process.env.OPENAI_API_KEY
 *
 * ElevenLabs API key:
 * 1) Agent secretsEnc `elevenlabsApiKey`
 * 2) TenantIntegration.elevenlabsApiKeyEnc
 * 3) process.env.ELEVENLABS_API_KEY
 *
 * To force workspace (tenant) keys for OpenAI, clear the per-agent OpenAI key in agent settings
 * (empty field + save) so secretsEnc no longer contains openaiApiKey.
 */

export type VoiceCredentialSource = 'agent' | 'tenant' | 'env' | 'none';

export type ResolvedSecret = {
  value: string | null;
  source: VoiceCredentialSource;
};

function trimOrNull(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

export function resolveOpenAiKeyChain(args: {
  agentSecretPlain: string | null | undefined;
  tenantEnc: string | null | undefined;
  decryptFromStorage: (enc: string) => string | null;
  envPlain: string | null | undefined;
  encryptionAvailable: boolean;
}): ResolvedSecret {
  const agent = trimOrNull(args.agentSecretPlain);
  if (agent) return { value: agent, source: 'agent' };

  if (args.encryptionAvailable && args.tenantEnc) {
    const dec = args.decryptFromStorage(args.tenantEnc);
    const t = trimOrNull(dec);
    if (t) return { value: t, source: 'tenant' };
  }

  const env = trimOrNull(args.envPlain ?? process.env.OPENAI_API_KEY);
  if (env) return { value: env, source: 'env' };

  return { value: null, source: 'none' };
}

/**
 * Layer presence for ops logging (independent of which layer wins).
 * - agentKeyPresent: non-empty OpenAI key in agent secrets JSON
 * - tenantKeyPresent: workspace row has a non-empty openai ciphertext blob
 * - envKeyPresent: OPENAI_API_KEY (or passed envPlain) is non-empty
 */
export function openAiKeyLayerPresence(args: {
  agentSecretPlain: string | null | undefined;
  tenantEnc: string | null | undefined;
  envPlain: string | null | undefined;
}): {
  agentKeyPresent: boolean;
  tenantKeyPresent: boolean;
  envKeyPresent: boolean;
} {
  return {
    agentKeyPresent: Boolean(trimOrNull(args.agentSecretPlain)),
    tenantKeyPresent: Boolean(args.tenantEnc?.trim()),
    envKeyPresent: Boolean(trimOrNull(args.envPlain ?? process.env.OPENAI_API_KEY)),
  };
}

export function resolveElevenLabsKeyChain(args: {
  agentSecretPlain: string | null | undefined;
  tenantEnc: string | null | undefined;
  decryptFromStorage: (enc: string) => string | null;
  envPlain: string | null | undefined;
  encryptionAvailable: boolean;
}): ResolvedSecret {
  const agent = trimOrNull(args.agentSecretPlain);
  if (agent) return { value: agent, source: 'agent' };

  if (args.encryptionAvailable && args.tenantEnc) {
    const dec = args.decryptFromStorage(args.tenantEnc);
    const t = trimOrNull(dec);
    if (t) return { value: t, source: 'tenant' };
  }

  const env = trimOrNull(args.envPlain ?? process.env.ELEVENLABS_API_KEY);
  if (env) return { value: env, source: 'env' };

  return { value: null, source: 'none' };
}
