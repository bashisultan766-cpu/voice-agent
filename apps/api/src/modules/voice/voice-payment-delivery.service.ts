/**
 * @deprecated Use `PaymentLinkDeliveryService` in `modules/delivery/` for multi-channel delivery.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { AgentsService } from '../agents/agents.service';
import { TwilioSmsService } from '../integrations/twilio/twilio-sms.service';
import { normalizePhoneNumber } from '../integrations/twilio/utils/normalize-phone';
import { gatedProcessEnv } from '../../common/provider-env-slice.util';
import { AgentEmailConfigService } from '../integrations/email/agent-email-config.service';
import { ResendEmailService } from '../integrations/email/resend-email.service';
import { paymentEmailIdempotencyKey } from '../../common/payment-email-idempotency';
import type { ResolvedAgentEmailConfig } from '../integrations/email/agent-email-config.service';
import type { VoicePaymentLineItem } from './voice-payment-catalog.service';

function assertHttpsUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new Error('Payment link URL must use HTTPS.');
  }
  return url.toString();
}

@Injectable()
export class VoicePaymentDeliveryService {
  private readonly logger = new Logger(VoicePaymentDeliveryService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly twilioSms: TwilioSmsService,
    private readonly agents: AgentsService,
    private readonly resendEmail: ResendEmailService,
    private readonly agentEmailConfig: AgentEmailConfigService,
  ) {}

  async sendBrandedPaymentEmail(args: {
    tenantId: string;
    agentId: string;
    checkoutLinkId: string;
    email: string;
    invoiceUrl: string;
    lineItem: VoicePaymentLineItem;
  }): Promise<{ ok: boolean; providerMessageId?: string; error?: string }> {
    const emailConfig = await this.resolveVoicePaymentEmailConfig(args.tenantId, args.agentId);
    if (!emailConfig) {
      return {
        ok: false,
        error:
          'Payment email is not configured. Set RESEND_API_KEY and PAYMENT_EMAIL_FROM (or RESEND_FROM_EMAIL), or configure agent email.',
      };
    }

    const branding = await this.resolveBusinessBranding(args.tenantId, args.agentId);

    try {
      const result = await this.resendEmail.sendPaymentEmail({
        tenantId: args.tenantId,
        agentId: args.agentId,
        checkoutLinkId: args.checkoutLinkId,
        idempotencyKey: paymentEmailIdempotencyKey({
          tenantId: args.tenantId,
          agentId: args.agentId,
          checkoutLinkId: args.checkoutLinkId,
          recipientEmail: args.email,
          purpose: 'voice_send_payment_link',
        }),
        to: args.email,
        businessName: branding.businessName,
        supportEmail: branding.supportEmail,
        supportPhone: branding.supportPhone,
        checkoutUrl: args.invoiceUrl,
        items: [
          {
            title: args.lineItem.title,
            quantity: args.lineItem.quantity,
            price: args.lineItem.price,
          },
        ],
        emailConfig,
      });

      const ok = result.success || result.deduplicated === true;
      return {
        ok,
        providerMessageId: result.providerMessageId ?? undefined,
        error: ok ? undefined : 'Resend payment email did not succeed.',
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendSmsPaymentLink(args: {
    phoneNumber: string;
    invoiceUrl: string;
    tenantId: string;
    agentId: string;
  }): Promise<{ ok: boolean; messageSid?: string; error?: string }> {
    const to = normalizePhoneNumber(args.phoneNumber.trim());
    if (!to || to.replace(/\D/g, '').length < 10) {
      return { ok: false, error: 'Invalid phone number.' };
    }

    let invoiceUrl: string;
    try {
      invoiceUrl = assertHttpsUrl(args.invoiceUrl.trim());
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const twilioCfg = await this.agents.getTwilioConfig(args.tenantId, args.agentId);
    const accountSid =
      twilioCfg?.accountSid ||
      this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim() ||
      gatedProcessEnv('TWILIO_ACCOUNT_SID', this.config);
    const authToken =
      twilioCfg?.authToken ||
      this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim() ||
      gatedProcessEnv('TWILIO_AUTH_TOKEN', this.config);
    const from =
      twilioCfg?.messagingFrom?.trim() ||
      this.twilioSms.defaultMessagingFrom() ||
      undefined;

    if (!accountSid || !authToken) {
      return { ok: false, error: 'Twilio credentials are not configured.' };
    }
    if (!from) {
      return { ok: false, error: 'TWILIO_MESSAGING_FROM is not configured.' };
    }

    try {
      const result = await this.twilioSms.sendSms({
        accountSid,
        authToken,
        from,
        to,
        body: `SureShot Books — complete your payment here: ${invoiceUrl}`,
      });
      return { ok: true, messageSid: result.sid };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async resolveVoicePaymentEmailConfig(
    tenantId: string,
    agentId: string,
  ): Promise<ResolvedAgentEmailConfig | null> {
    const paymentFromOverride = this.config.get<string>('PAYMENT_EMAIL_FROM')?.trim();
    const resolved = await this.agentEmailConfig.resolveForSend(tenantId, agentId);
    if (resolved) {
      if (paymentFromOverride) {
        return { ...resolved, from: paymentFromOverride };
      }
      return resolved;
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

  private async resolveBusinessBranding(
    tenantId: string,
    agentId: string,
  ): Promise<{
    businessName: string;
    supportEmail: string | null;
    supportPhone: string | null;
  }> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        agentConfig: {
          select: { businessName: true, supportEmail: true, supportPhone: true },
        },
        client: { select: { name: true, contactEmail: true, contactPhone: true } },
      },
    });

    return {
      businessName:
        agent?.agentConfig?.businessName?.trim() ||
        agent?.client?.name?.trim() ||
        'SureShot Books',
      supportEmail: agent?.agentConfig?.supportEmail ?? agent?.client?.contactEmail ?? null,
      supportPhone: agent?.agentConfig?.supportPhone ?? agent?.client?.contactPhone ?? null,
    };
  }
}
