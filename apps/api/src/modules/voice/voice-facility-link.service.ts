import { createHmac, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { gatedProcessEnv } from '../../common/provider-env-slice.util';
import { AgentEmailConfigService } from '../integrations/email/agent-email-config.service';
import { ResendEmailService } from '../integrations/email/resend-email.service';
import { maskEmailForLog } from '../calls/runtime/voice-email-capture.util';
import type { ResolvedAgentEmailConfig } from '../integrations/email/agent-email-config.service';

export type FacilityLinkResult = {
  success: boolean;
  link?: string;
  emailSent?: boolean;
  error?: string;
};

@Injectable()
export class VoiceFacilityLinkService {
  private readonly logger = new Logger(VoiceFacilityLinkService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly resendEmail: ResendEmailService,
    private readonly agentEmailConfig: AgentEmailConfigService,
  ) {}

  createSecureCompletionLink(orderNumber: string, email: string): string {
    const baseUrl = this.resolveFacilityLinkBaseUrl();
    const normalizedOrder = orderNumber.trim();
    const normalizedEmail = email.trim().toLowerCase();
    const issuedAt = Date.now();
    const token = this.signFacilityToken(normalizedOrder, normalizedEmail, issuedAt);

    const url = new URL('/facility/complete', baseUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('order', normalizedOrder);
    url.searchParams.set('email', normalizedEmail);
    return url.toString();
  }

  async sendLinkToEmail(args: {
    email: string;
    link: string;
    orderNumber: string;
    tenantId: string;
    agentId: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const email = args.email.trim().toLowerCase();
    if (!email.includes('@')) {
      return { ok: false, error: 'A valid email is required.' };
    }

    const emailConfig = await this.resolveFacilityEmailConfig(args.tenantId, args.agentId);
    if (!emailConfig?.apiKey || !emailConfig.from) {
      return { ok: false, error: 'Facility payment email is not configured for this agent.' };
    }

    try {
      const result = await this.resendEmail.sendPaymentEmail({
        tenantId: args.tenantId,
        agentId: args.agentId,
        checkoutLinkId: `facility-${args.orderNumber}-${Date.now()}`,
        to: email,
        businessName: 'SureShot Books',
        checkoutUrl: args.link,
        items: [
          {
            title: `Facility payment — order ${args.orderNumber}`,
            quantity: 1,
            price: null,
          },
        ],
        emailConfig,
      });

      return {
        ok: result.success || result.deduplicated === true,
        error: result.success ? undefined : 'Email delivery did not succeed.',
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  logLinkSent(orderNumber: string, email: string, timestamp: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'facility_link_sent',
        orderNumber: orderNumber.slice(0, 32),
        maskedEmail: maskEmailForLog(email),
        timestamp,
      }),
    );
  }

  async sendFacilityPaymentLink(args: {
    orderNumber: string;
    email: string;
    tenantId?: string;
    agentId?: string;
  }): Promise<FacilityLinkResult> {
    const { tenantId, agentId } = await this.resolveAgentContext(args.tenantId, args.agentId);
    const link = this.createSecureCompletionLink(args.orderNumber, args.email);
    const sent = await this.sendLinkToEmail({
      email: args.email,
      link,
      orderNumber: args.orderNumber,
      tenantId,
      agentId,
    });

    const timestamp = new Date().toISOString();
    if (sent.ok) {
      this.logLinkSent(args.orderNumber, args.email, timestamp);
    }

    return {
      success: sent.ok,
      link: sent.ok ? undefined : link,
      emailSent: sent.ok,
      error: sent.error,
    };
  }

  private resolveFacilityLinkBaseUrl(): string {
    const configured =
      this.config.get<string>('FACILITY_COMPLETION_BASE_URL')?.trim() ||
      this.config.get<string>('VOICE_COMMERCE_PUBLIC_URL')?.trim() ||
      this.config.get<string>('PUBLIC_APP_URL')?.trim();

    if (configured) {
      const url = new URL(configured.endsWith('/') ? configured : `${configured}/`);
      if (url.protocol === 'https:') return url.origin;
    }

    return 'https://sureshotbooks.com';
  }

  private async resolveFacilityEmailConfig(
    tenantId: string,
    agentId: string,
  ): Promise<ResolvedAgentEmailConfig | null> {
    const paymentFromOverride = this.config.get<string>('PAYMENT_EMAIL_FROM')?.trim();
    const resolved = await this.agentEmailConfig.resolveForSend(tenantId, agentId);
    if (resolved) {
      return paymentFromOverride ? { ...resolved, from: paymentFromOverride } : resolved;
    }

    const apiKey =
      this.config.get<string>('RESEND_API_KEY')?.trim() ||
      gatedProcessEnv('RESEND_API_KEY', this.config);
    const from =
      paymentFromOverride ||
      this.config.get<string>('RESEND_FROM_EMAIL')?.trim() ||
      gatedProcessEnv('RESEND_FROM_EMAIL', this.config);
    if (!apiKey || !from) return null;
    return { apiKey, from, source: 'env' };
  }

  private async resolveAgentContext(
    tenantId?: string,
    agentId?: string,
  ): Promise<{ tenantId: string; agentId: string }> {
    const envTenant = this.config.get<string>('VOICE_DEFAULT_TENANT_ID')?.trim();
    const envAgent = this.config.get<string>('VOICE_DEFAULT_AGENT_ID')?.trim();
    const resolvedTenant = tenantId?.trim() || envTenant;
    const resolvedAgent = agentId?.trim() || envAgent;

    if (resolvedTenant && resolvedAgent) {
      return { tenantId: resolvedTenant, agentId: resolvedAgent };
    }

    const agent = await this.prisma.agent.findFirst({
      where: { deletedAt: null, status: { in: [AgentStatus.ACTIVE, AgentStatus.READY] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, tenantId: true },
    });
    if (!agent) {
      throw new BadRequestException(
        'No agent context. Provide tenantId/agentId or set VOICE_DEFAULT_TENANT_ID and VOICE_DEFAULT_AGENT_ID.',
      );
    }
    return { tenantId: resolvedTenant ?? agent.tenantId, agentId: resolvedAgent ?? agent.id };
  }

  private signFacilityToken(orderNumber: string, email: string, issuedAt: number): string {
    const secret =
      this.config.get<string>('FACILITY_LINK_SIGNING_SECRET')?.trim() ||
      this.config.get<string>('JWT_SECRET')?.trim() ||
      randomBytes(32).toString('hex');

    const payload = `${orderNumber}:${email}:${issuedAt}`;
    return createHmac('sha256', secret).update(payload).digest('hex').slice(0, 48);
  }
}
