import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gatedProcessEnv } from '../../common/provider-env-slice.util';

export type EmailProvider = 'resend' | 'sendgrid';

export type SendPaymentLinkEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
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

  resolveProvider(): EmailProvider {
    const raw =
      this.config.get<string>('EMAIL_PROVIDER')?.trim().toLowerCase() ||
      gatedProcessEnv('EMAIL_PROVIDER', this.config)?.toLowerCase() ||
      'resend';
    return raw === 'sendgrid' ? 'sendgrid' : 'resend';
  }

  resolveFromEmail(): string | null {
    return (
      this.config.get<string>('FROM_EMAIL')?.trim() ||
      this.config.get<string>('PAYMENT_EMAIL_FROM')?.trim() ||
      this.config.get<string>('RESEND_FROM_EMAIL')?.trim() ||
      gatedProcessEnv('FROM_EMAIL', this.config) ||
      gatedProcessEnv('PAYMENT_EMAIL_FROM', this.config) ||
      gatedProcessEnv('RESEND_FROM_EMAIL', this.config) ||
      null
    );
  }

  /**
   * Ensures FROM uses a domain that matches VERIFIED_EMAIL_DOMAIN when set.
   */
  verifySenderDomain(fromEmail: string): { ok: boolean; reason?: string } {
    const verified =
      this.config.get<string>('VERIFIED_EMAIL_DOMAIN')?.trim() ||
      gatedProcessEnv('VERIFIED_EMAIL_DOMAIN', this.config);
    if (!verified) return { ok: true };

    const match = fromEmail.match(/@([^>\s]+)/);
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
    const from = this.resolveFromEmail();
    const provider = this.resolveProvider();

    this.logger.log(
      JSON.stringify({
        event: 'email_attempted',
        provider,
        recipientDomain: to.split('@')[1] ?? null,
      }),
    );

    if (!from) {
      const error = 'FROM_EMAIL (or PAYMENT_EMAIL_FROM / RESEND_FROM_EMAIL) is not configured.';
      this.logger.error(JSON.stringify({ event: 'email_failed', provider, error }));
      return { ok: false, provider, error };
    }

    const domainCheck = this.verifySenderDomain(from);
    if (!domainCheck.ok) {
      this.logger.warn(
        JSON.stringify({
          event: 'email_failed',
          provider,
          reason: 'sender_domain_mismatch',
          message: domainCheck.reason,
        }),
      );
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
              replyTo: input.replyTo,
            })
          : await this.sendViaResend({
              from,
              to,
              subject: input.subject,
              html: input.html,
              text: input.text,
              replyTo: input.replyTo,
            });

      this.logger.log(
        JSON.stringify({
          event: result.ok ? 'email_sent' : 'email_failed',
          provider,
          messageId: result.messageId ?? null,
        }),
      );
      this.logger.log(
        JSON.stringify({
          event: 'email_provider_response',
          provider,
          ok: result.ok,
          response: result.providerResponse ?? null,
        }),
      );
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(JSON.stringify({ event: 'email_failed', provider, error: error.slice(0, 400) }));
      return { ok: false, provider, error };
    }
  }

  private async sendViaResend(args: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string | null;
  }): Promise<SendPaymentLinkEmailResult> {
    const apiKey =
      this.config.get<string>('RESEND_API_KEY')?.trim() ||
      gatedProcessEnv('RESEND_API_KEY', this.config);
    if (!apiKey) {
      return { ok: false, provider: 'resend', error: 'RESEND_API_KEY is not configured.' };
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

    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
    };

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
  }): Promise<SendPaymentLinkEmailResult> {
    const apiKey =
      this.config.get<string>('SENDGRID_API_KEY')?.trim() ||
      gatedProcessEnv('SENDGRID_API_KEY', this.config);
    if (!apiKey) {
      return { ok: false, provider: 'sendgrid', error: 'SENDGRID_API_KEY is not configured.' };
    }

    const personalizations = [{ to: [{ email: args.to }] }];
    const content = [
      { type: 'text/plain', value: args.text },
      { type: 'text/html', value: args.html },
    ];
    const mail: Record<string, unknown> = {
      personalizations,
      from: { email: extractEmailAddress(args.from), name: extractDisplayName(args.from) },
      subject: args.subject,
      content,
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
