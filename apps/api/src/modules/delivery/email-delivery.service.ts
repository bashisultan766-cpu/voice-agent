import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gatedProcessEnv } from '../../common/provider-env-slice.util';

export type EmailProvider = 'resend' | 'sendgrid';

export type PaymentLinkEmailCredentials = {
  apiKey: string;
  from: string;
  replyTo?: string | null;
  provider?: EmailProvider;
};

export type SendPaymentLinkEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  /** Agent/workspace/env resolved credentials (preferred in production). */
  credentials?: PaymentLinkEmailCredentials | null;
};

export type SendPaymentLinkEmailResult = {
  ok: boolean;
  messageId?: string;
  provider: EmailProvider;
  error?: string;
  providerResponse?: unknown;
};

@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(private readonly config: ConfigService) {}

  /** Read env whether or not ALLOW_PROVIDER_ENV_FALLBACK is set. */
  private envString(key: string): string | undefined {
    const fromConfig = this.config.get<string>(key);
    if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim();
    const raw = process.env[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  }

  resolveProvider(override?: EmailProvider): EmailProvider {
    const raw =
      override ||
      this.envString('EMAIL_PROVIDER')?.toLowerCase() ||
      gatedProcessEnv('EMAIL_PROVIDER', this.config)?.toLowerCase() ||
      'resend';
    return raw === 'sendgrid' ? 'sendgrid' : 'resend';
  }

  resolveFromEmail(): string | null {
    return (
      this.envString('FROM_EMAIL') ||
      this.envString('PAYMENT_EMAIL_FROM') ||
      this.envString('RESEND_FROM_EMAIL') ||
      null
    );
  }

  verifySenderDomain(fromEmail: string): { ok: boolean; reason?: string } {
    const verified = this.envString('VERIFIED_EMAIL_DOMAIN') || gatedProcessEnv('VERIFIED_EMAIL_DOMAIN', this.config);
    if (!verified) return { ok: true };

    const emailOnly = extractEmailAddress(fromEmail);
    const match = emailOnly.match(/@([^>\s]+)/);
    const domain = match?.[1]?.toLowerCase();
    if (!domain) {
      return { ok: false, reason: 'FROM email does not contain a valid domain.' };
    }
    const expected = verified.replace(/^@/, '').toLowerCase();
    if (domain !== expected && !domain.endsWith(`.${expected}`)) {
      return {
        ok: false,
        reason: `FROM domain "${domain}" does not match verified domain "${expected}".`,
      };
    }
    return { ok: true };
  }

  async sendPaymentLinkEmail(input: SendPaymentLinkEmailInput): Promise<SendPaymentLinkEmailResult> {
    const to = input.to.trim().toLowerCase();
    const provider = input.credentials?.provider ?? this.resolveProvider();
    const from = input.credentials?.from?.trim() || this.resolveFromEmail();
    const apiKeyFromCredentials = input.credentials?.apiKey?.trim();

    if (!from) {
      return {
        ok: false,
        provider,
        error: 'FROM_EMAIL (or PAYMENT_EMAIL_FROM / RESEND_FROM_EMAIL / agent email) is not configured.',
      };
    }

    const domainCheck = this.verifySenderDomain(from);
    if (!domainCheck.ok) {
      return { ok: false, provider, error: domainCheck.reason };
    }

    try {
      const result =
        provider === 'sendgrid'
          ? await this.sendViaSendGrid({
              from,
              to,
              subject: input.subject,
              html: input.html,
              text: input.text,
              replyTo: input.credentials?.replyTo ?? input.replyTo,
              apiKey: apiKeyFromCredentials,
            })
          : await this.sendViaResend({
              from,
              to,
              subject: input.subject,
              html: input.html,
              text: input.text,
              replyTo: input.credentials?.replyTo ?? input.replyTo,
              apiKey: apiKeyFromCredentials,
            });

      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, provider, error };
    }
  }

  private resolveResendApiKey(override?: string): string | undefined {
    return override || this.envString('RESEND_API_KEY') || gatedProcessEnv('RESEND_API_KEY', this.config);
  }

  private resolveSendGridApiKey(override?: string): string | undefined {
    return override || this.envString('SENDGRID_API_KEY') || gatedProcessEnv('SENDGRID_API_KEY', this.config);
  }

  private async sendViaResend(args: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string | null;
    apiKey?: string;
  }): Promise<SendPaymentLinkEmailResult> {
    const apiKey = this.resolveResendApiKey(args.apiKey);
    if (!apiKey) {
      return { ok: false, provider: 'resend', error: 'RESEND_API_KEY is not configured (env or agent).' };
    }

    const payload: Record<string, unknown> = {
      from: args.from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    };
    if (args.replyTo?.trim()) payload.reply_to = args.replyTo.trim();

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };

    if (!response.ok) {
      return {
        ok: false,
        provider: 'resend',
        error: body.message || `Resend HTTP ${response.status}`,
        providerResponse: { status: response.status, body },
      };
    }

    return {
      ok: true,
      provider: 'resend',
      messageId: body.id,
      providerResponse: { status: response.status, body },
    };
  }

  private async sendViaSendGrid(args: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string | null;
    apiKey?: string;
  }): Promise<SendPaymentLinkEmailResult> {
    const apiKey = this.resolveSendGridApiKey(args.apiKey);
    if (!apiKey) {
      return { ok: false, provider: 'sendgrid', error: 'SENDGRID_API_KEY is not configured (env or agent).' };
    }

    const mail: Record<string, unknown> = {
      personalizations: [{ to: [{ email: args.to }] }],
      from: { email: extractEmailAddress(args.from), name: extractDisplayName(args.from) },
      subject: args.subject,
      content: [
        { type: 'text/plain', value: args.text },
        { type: 'text/html', value: args.html },
      ],
    };
    if (args.replyTo?.trim()) {
      mail.reply_to = { email: args.replyTo.trim() };
    }

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mail),
    });

    const messageId = response.headers.get('x-message-id') ?? undefined;
    const text = await response.text().catch(() => '');

    if (!response.ok) {
      return {
        ok: false,
        provider: 'sendgrid',
        error: text.slice(0, 300) || `SendGrid HTTP ${response.status}`,
        providerResponse: { status: response.status, body: text.slice(0, 500) },
      };
    }

    return {
      ok: true,
      provider: 'sendgrid',
      messageId,
      providerResponse: { status: response.status, messageId },
    };
  }
}

function extractEmailAddress(from: string): string {
  const angle = from.match(/<([^>]+)>/);
  if (angle?.[1]) return angle[1].trim();
  const bare = from.match(/[^\s<>]+@[^\s<>]+/);
  return bare?.[0]?.trim() ?? from.trim();
}

function extractDisplayName(from: string): string | undefined {
  const angle = from.match(/^(.+?)\s*</);
  if (angle?.[1]) {
    const name = angle[1].replace(/^["']|["']$/g, '').trim();
    return name || undefined;
  }
  return undefined;
}
