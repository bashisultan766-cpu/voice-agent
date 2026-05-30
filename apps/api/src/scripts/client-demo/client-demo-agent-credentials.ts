import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from '../../common/encryption.service';
import { ConfigService } from '@nestjs/config';
import {
  resolveElevenLabsConfig,
  resolveOpenAiConfig,
  resolveTwilioConfig,
  type AgentSecretsSlice,
  type WorkspaceIntegrationSlice,
} from '../../common/credential-resolver.util';
import { allowProviderEnvFallback } from '../../common/provider-env-fallback.util';

function providerEnvSlice(config: ConfigService): {
  shopifyAdminToken?: string;
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  resendApiKey?: string;
} {
  if (!allowProviderEnvFallback()) return {};
  return {
    shopifyAdminToken: config.get<string>('SHOPIFY_ADMIN_API_TOKEN')?.trim(),
    openaiApiKey: config.get<string>('OPENAI_API_KEY')?.trim(),
    elevenlabsApiKey: config.get<string>('ELEVENLABS_API_KEY')?.trim(),
    twilioAccountSid: config.get<string>('TWILIO_ACCOUNT_SID')?.trim(),
    twilioAuthToken: config.get<string>('TWILIO_AUTH_TOKEN')?.trim(),
    resendApiKey: config.get<string>('RESEND_API_KEY')?.trim(),
  };
}

function decryptSecrets(
  encryption: EncryptionService,
  secretsEnc: string | null,
): AgentSecretsSlice {
  if (!secretsEnc || !encryption.isAvailable()) return {};
  const decrypted = encryption.decryptFromStorage(secretsEnc);
  if (!decrypted) return {};
  try {
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    const out: AgentSecretsSlice = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) (out as Record<string, string>)[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadAgentCredentialContext(
  app: INestApplicationContext,
  tenantId: string,
  agentId: string,
) {
  const prisma = app.get(PrismaService);
  const encryption = app.get(EncryptionService);
  const config = app.get(ConfigService);

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, tenantId, deletedAt: null },
    select: {
      twilioPhoneNumber: true,
      voiceId: true,
      voiceProvider: true,
      secretsEnc: true,
      agentConfig: {
        select: {
          useWorkspaceShopify: true,
          useWorkspaceEmail: true,
          useWorkspaceOpenai: true,
          useWorkspaceElevenlabs: true,
          useWorkspaceTwilio: true,
        },
      },
    },
  });
  if (!agent) throw new Error('Agent not found');

  const tenantIntegration = await prisma.tenantIntegration.findUnique({
    where: { tenantId },
    select: {
      shopifyShopDomain: true,
      shopifyAdminTokenEnc: true,
      openaiApiKeyEnc: true,
      elevenlabsApiKeyEnc: true,
      elevenlabsDefaultVoiceId: true,
      twilioAccountSid: true,
      twilioAuthTokenEnc: true,
      twilioPhoneNumber: true,
      resendApiKeyEnc: true,
      resendFromEmail: true,
    },
  });

  const workspace: WorkspaceIntegrationSlice | null = tenantIntegration
    ? {
        shopifyStoreUrl: tenantIntegration.shopifyShopDomain ?? undefined,
        shopifyAdminToken: tenantIntegration.shopifyAdminTokenEnc
          ? encryption.decryptFromStorage(tenantIntegration.shopifyAdminTokenEnc) ?? undefined
          : undefined,
        openaiApiKey: tenantIntegration.openaiApiKeyEnc
          ? encryption.decryptFromStorage(tenantIntegration.openaiApiKeyEnc) ?? undefined
          : undefined,
        elevenlabsApiKey: tenantIntegration.elevenlabsApiKeyEnc
          ? encryption.decryptFromStorage(tenantIntegration.elevenlabsApiKeyEnc) ?? undefined
          : undefined,
        elevenlabsDefaultVoiceId: tenantIntegration.elevenlabsDefaultVoiceId ?? undefined,
        twilioAccountSid: tenantIntegration.twilioAccountSid ?? undefined,
        twilioAuthToken: tenantIntegration.twilioAuthTokenEnc
          ? encryption.decryptFromStorage(tenantIntegration.twilioAuthTokenEnc) ?? undefined
          : undefined,
        twilioPhoneNumber: tenantIntegration.twilioPhoneNumber ?? undefined,
        resendApiKey: tenantIntegration.resendApiKeyEnc
          ? encryption.decryptFromStorage(tenantIntegration.resendApiKeyEnc) ?? undefined
          : undefined,
        resendFromEmail: tenantIntegration.resendFromEmail ?? undefined,
      }
    : null;

  const secrets = decryptSecrets(encryption, agent.secretsEnc);
  const env = providerEnvSlice(config);

  const twilio = resolveTwilioConfig({
    agentSecrets: secrets,
    workspace,
    useWorkspaceTwilio: agent.agentConfig?.useWorkspaceTwilio === true,
    agentPhoneNumber: agent.twilioPhoneNumber,
  });

  const openai = resolveOpenAiConfig({
    agentSecrets: secrets,
    workspace,
    useWorkspaceOpenai: agent.agentConfig?.useWorkspaceOpenai === true,
    envApiKey: env.openaiApiKey,
  });

  const elevenlabs = resolveElevenLabsConfig({
    agentSecrets: secrets,
    workspace,
    useWorkspaceElevenlabs: agent.agentConfig?.useWorkspaceElevenlabs === true,
    agentVoiceId: agent.voiceId,
    envApiKey: env.elevenlabsApiKey,
  });

  return {
    agent,
    twilio,
    openai,
    elevenlabs,
    resendApiKey:
      secrets.resendApiKey?.trim() ||
      workspace?.resendApiKey?.trim() ||
      env.resendApiKey,
  };
}
