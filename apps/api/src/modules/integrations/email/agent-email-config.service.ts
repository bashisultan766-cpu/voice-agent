import { Injectable } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../../database/prisma.service';

import { EncryptionService } from '../../../common/encryption.service';

import {

  resolveEmailFromAddress,

  resolveEmailKeyConfig,

  type CredentialSource,

} from '../../../common/credential-resolver.util';

import { allowProviderEnvFallback } from '../../../common/provider-env-fallback.util';



export type ResolvedAgentEmailConfig = {

  apiKey: string;

  from: string;

  replyTo?: string;

  subjectTemplate?: string;

  paymentLinkIntro?: string;

  source: Exclude<CredentialSource, 'missing'>;

};



export type AgentEmailConfigSummary = {

  configured: boolean;

  resendKeyConfigured: boolean;

  resendKeySource: 'agent' | 'workspace' | 'env' | 'missing';

  senderConfigured: boolean;

  emailSenderName: string | null;

  emailSenderAddress: string | null;

  emailReplyTo: string | null;

  emailSubjectTemplate: string | null;

  paymentLinkEmailIntro: string | null;

  emailTestRecipient: string | null;

  useWorkspaceEmail: boolean;

};



@Injectable()

export class AgentEmailConfigService {

  constructor(

    private readonly prisma: PrismaService,

    private readonly encryption: EncryptionService,

    private readonly config: ConfigService,

  ) {}



  private decryptSecretsBlob(secretsEnc: string | null): Record<string, string> {

    if (!secretsEnc || !this.encryption.isAvailable()) return {};

    const decrypted = this.encryption.decryptFromStorage(secretsEnc);

    if (!decrypted) return {};

    try {

      const parsed = JSON.parse(decrypted) as Record<string, unknown>;

      const out: Record<string, string> = {};

      for (const [k, v] of Object.entries(parsed)) {

        if (typeof v === 'string' && v.trim()) out[k] = v.trim();

      }

      return out;

    } catch {

      return {};

    }

  }



  formatFromAddress(senderName: string | null | undefined, senderEmail: string): string {

    const email = senderEmail.trim();

    const name = senderName?.trim();

    if (!name) return email;

    const safeName = name.replace(/[<>"]/g, '');

    return `${safeName} <${email}>`;

  }



  async getSummary(tenantId: string, agentId: string): Promise<AgentEmailConfigSummary | null> {

    const agent = await this.prisma.agent.findFirst({

      where: { id: agentId, tenantId, deletedAt: null },

      select: {

        secretsEnc: true,

        agentConfig: {

          select: {

            emailSenderName: true,

            emailSenderAddress: true,

            emailReplyTo: true,

            emailSubjectTemplate: true,

            paymentLinkEmailIntro: true,

            emailTestRecipient: true,

            useWorkspaceEmail: true,

          },

        },

      },

    });

    if (!agent) return null;



    const cfg = agent.agentConfig;

    const secrets = this.decryptSecretsBlob(agent.secretsEnc);

    const integration = await this.prisma.tenantIntegration.findUnique({

      where: { tenantId },

      select: { resendApiKeyEnc: true, resendFromEmail: true },

    });

    const workspaceKey =

      integration?.resendApiKeyEnc && this.encryption.isAvailable()

        ? this.encryption.decryptFromStorage(integration.resendApiKeyEnc)

        : undefined;

    const useWorkspace = cfg?.useWorkspaceEmail === true;

    const keyResolved = resolveEmailKeyConfig({

      agentSecrets: secrets,

      workspace: workspaceKey ? { resendApiKey: workspaceKey } : null,

      useWorkspaceEmail: useWorkspace,

      envApiKey: allowProviderEnvFallback() ? this.config.get<string>('RESEND_API_KEY') : undefined,

    });

    const fromResolved = resolveEmailFromAddress({

      agentSenderAddress: cfg?.emailSenderAddress,

      workspaceFromEmail: integration?.resendFromEmail,

      envFromEmail: allowProviderEnvFallback() ? this.config.get<string>('RESEND_FROM_EMAIL') : undefined,

      useWorkspaceEmail: useWorkspace,

    });



    return {

      configured: Boolean(keyResolved) && Boolean(fromResolved),

      resendKeyConfigured: Boolean(keyResolved),

      resendKeySource: keyResolved?.source ?? 'missing',

      senderConfigured: Boolean(fromResolved),

      emailSenderName: cfg?.emailSenderName ?? null,

      emailSenderAddress: cfg?.emailSenderAddress ?? null,

      emailReplyTo: cfg?.emailReplyTo ?? null,

      emailSubjectTemplate: cfg?.emailSubjectTemplate ?? null,

      paymentLinkEmailIntro: cfg?.paymentLinkEmailIntro ?? null,

      emailTestRecipient: cfg?.emailTestRecipient ?? null,

      useWorkspaceEmail: useWorkspace,

    };

  }



  async resolveForSend(tenantId: string, agentId: string): Promise<ResolvedAgentEmailConfig | null> {

    const agent = await this.prisma.agent.findFirst({

      where: { id: agentId, tenantId, deletedAt: null },

      select: {

        secretsEnc: true,

        agentConfig: {

          select: {

            emailSenderName: true,

            emailSenderAddress: true,

            emailReplyTo: true,

            emailSubjectTemplate: true,

            paymentLinkEmailIntro: true,

            useWorkspaceEmail: true,

          },

        },

      },

    });

    if (!agent) return null;



    const cfg = agent.agentConfig;

    const secrets = this.decryptSecretsBlob(agent.secretsEnc);

    const integration = await this.prisma.tenantIntegration.findUnique({

      where: { tenantId },

      select: { resendApiKeyEnc: true, resendFromEmail: true },

    });

    const workspaceKey =

      integration?.resendApiKeyEnc && this.encryption.isAvailable()

        ? this.encryption.decryptFromStorage(integration.resendApiKeyEnc)

        : undefined;

    const useWorkspace = cfg?.useWorkspaceEmail === true;

    const keyResolved = resolveEmailKeyConfig({

      agentSecrets: secrets,

      workspace: workspaceKey ? { resendApiKey: workspaceKey } : undefined,

      useWorkspaceEmail: useWorkspace,

      envApiKey: allowProviderEnvFallback() ? this.config.get<string>('RESEND_API_KEY') : undefined,

    });

    const fromEmailResolved = resolveEmailFromAddress({

      agentSenderAddress: cfg?.emailSenderAddress,

      workspaceFromEmail: integration?.resendFromEmail,

      envFromEmail: allowProviderEnvFallback() ? this.config.get<string>('RESEND_FROM_EMAIL') : undefined,

      useWorkspaceEmail: useWorkspace,

    });

    if (!keyResolved || !fromEmailResolved) return null;



    return {

      apiKey: keyResolved.apiKey,

      from: this.formatFromAddress(cfg?.emailSenderName, fromEmailResolved.address),

      replyTo: cfg?.emailReplyTo?.trim() || undefined,

      subjectTemplate: cfg?.emailSubjectTemplate?.trim() || undefined,

      paymentLinkIntro: cfg?.paymentLinkEmailIntro?.trim() || undefined,

      source: keyResolved.source,

    };

  }

}


