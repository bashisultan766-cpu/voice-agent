/**
 * Voice runtime credential precedence (aligned with credential-resolver.util.ts):
 *
 * OpenAI / ElevenLabs:
 * 1) Agent secretsEnc JSON when non-empty after decrypt
 * 2) TenantIntegration when useWorkspace* flag is true and decrypt succeeds
 * 3) process.env only when ALLOW_PROVIDER_ENV_FALLBACK=true
 */

import { allowProviderEnvFallback } from '../../../common/provider-env-fallback.util';

export type VoiceCredentialSource = 'agent' | 'tenant' | 'env' | 'none';

export type ResolvedSecret = {
  value: string | null;
  source: VoiceCredentialSource;
};

function trimOrNull(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function gatedEnvPlain(envPlain: string | null | undefined): string | null {
  if (!allowProviderEnvFallback()) return null;
  return trimOrNull(envPlain);
}

export function resolveOpenAiKeyChain(args: {
  agentSecretPlain: string | null | undefined;
  tenantEnc: string | null | undefined;
  decryptFromStorage: (enc: string) => string | null;
  envPlain?: string | null | undefined;
  encryptionAvailable: boolean;
  useWorkspaceOpenai?: boolean;
}): ResolvedSecret {
  const agent = trimOrNull(args.agentSecretPlain);
  if (agent) return { value: agent, source: 'agent' };

  if (args.useWorkspaceOpenai === true && args.encryptionAvailable && args.tenantEnc) {
    const dec = args.decryptFromStorage(args.tenantEnc);
    const t = trimOrNull(dec);
    if (t) return { value: t, source: 'tenant' };
  }

  const env = gatedEnvPlain(args.envPlain);
  if (env) return { value: env, source: 'env' };

  return { value: null, source: 'none' };
}

export function openAiKeyLayerPresence(args: {
  agentSecretPlain: string | null | undefined;
  tenantEnc: string | null | undefined;
  envPlain?: string | null | undefined;
  useWorkspaceOpenai?: boolean;
}): {
  agentKeyPresent: boolean;
  tenantKeyPresent: boolean;
  envKeyPresent: boolean;
} {
  return {
    agentKeyPresent: Boolean(trimOrNull(args.agentSecretPlain)),
    tenantKeyPresent:
      args.useWorkspaceOpenai === true ? Boolean(args.tenantEnc?.trim()) : false,
    envKeyPresent: Boolean(gatedEnvPlain(args.envPlain)),
  };
}

export function resolveElevenLabsKeyChain(args: {
  agentSecretPlain: string | null | undefined;
  tenantEnc: string | null | undefined;
  decryptFromStorage: (enc: string) => string | null;
  envPlain?: string | null | undefined;
  encryptionAvailable: boolean;
  useWorkspaceElevenlabs?: boolean;
}): ResolvedSecret {
  const agent = trimOrNull(args.agentSecretPlain);
  if (agent) return { value: agent, source: 'agent' };

  if (args.useWorkspaceElevenlabs === true && args.encryptionAvailable && args.tenantEnc) {
    const dec = args.decryptFromStorage(args.tenantEnc);
    const t = trimOrNull(dec);
    if (t) return { value: t, source: 'tenant' };
  }

  const env = gatedEnvPlain(args.envPlain);
  if (env) return { value: env, source: 'env' };

  return { value: null, source: 'none' };
}
