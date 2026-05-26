import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import {
  resolveTwilioAuthToken,
  type AgentSecretsSlice,
  type CredentialSource,
} from '../../../common/credential-resolver.util';
import { allowProviderEnvFallback } from '../../../common/provider-env-fallback.util';
import { gatedProcessEnv } from '../../../common/provider-env-slice.util';
import { AgentResolutionService } from './agent-resolution.service';

/**
 * Resolves Twilio auth tokens for webhook signature validation.
 * Uses per-agent (or workspace when opted-in) credentials; global TWILIO_AUTH_TOKEN only when ALLOW_PROVIDER_ENV_FALLBACK=true.
 */
@Injectable()
export class TwilioAuthTokenResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    private readonly agentResolution: AgentResolutionService,
  ) {}

  /** Ordered unique auth tokens to try when validating X-Twilio-Signature. */
  async resolveValidationTokens(toNumber: string | undefined): Promise<
    Array<{ token: string; source: CredentialSource | 'env_global' }>
  > {
    const out: Array<{ token: string; source: CredentialSource | 'env_global' }> = [];
    const seen = new Set<string>();

    const push = (token: string | undefined, source: CredentialSource | 'env_global') => {
      const t = token?.trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push({ token: t, source });
    };

    if (toNumber?.trim()) {
      const ctx = await this.agentResolution.resolveByPhoneNumber(toNumber);
      if (ctx) {
        const agent = await this.prisma.agent.findFirst({
          where: { id: ctx.agentId, tenantId: ctx.tenantId, deletedAt: null },
          select: {
            secretsEnc: true,
            agentConfig: { select: { useWorkspaceTwilio: true } },
          },
        });
        let secrets: AgentSecretsSlice = {};
        if (agent?.secretsEnc && this.encryption.isAvailable()) {
          const dec = this.encryption.decryptFromStorage(agent.secretsEnc);
          if (dec) {
            try {
              secrets = JSON.parse(dec) as AgentSecretsSlice;
            } catch {
              secrets = {};
            }
          }
        }
        const integration = await this.prisma.tenantIntegration.findUnique({
          where: { tenantId: ctx.tenantId },
          select: { twilioAccountSid: true, twilioAuthTokenEnc: true },
        });
        const workspace =
          integration && this.encryption.isAvailable()
            ? {
                twilioAccountSid: integration.twilioAccountSid ?? undefined,
                twilioAuthToken: integration.twilioAuthTokenEnc
                  ? (this.encryption.decryptFromStorage(integration.twilioAuthTokenEnc) ?? undefined)
                  : undefined,
              }
            : null;
        const resolved = resolveTwilioAuthToken({
          agentSecrets: secrets,
          workspace,
          useWorkspaceTwilio: agent?.agentConfig?.useWorkspaceTwilio === true,
        });
        if (resolved) push(resolved.token, resolved.source);
      }
    }

    if (allowProviderEnvFallback()) {
      push(gatedProcessEnv('TWILIO_AUTH_TOKEN', this.config), 'env_global');
    }
    return out;
  }
}
