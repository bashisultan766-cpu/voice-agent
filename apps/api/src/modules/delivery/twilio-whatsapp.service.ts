import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { gatedProcessEnv } from '../../common/provider-env-slice.util';
import { TwilioSmsService } from '../integrations/twilio/twilio-sms.service';
import { AgentsService } from '../agents/agents.service';

@Injectable()
export class TwilioWhatsAppService {
  private readonly logger = new Logger(TwilioWhatsAppService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly twilioSms: TwilioSmsService,
    private readonly agents: AgentsService,
  ) {}

  isEnabled(): boolean {
    return (
      this.config.get<string>('WHATSAPP_ENABLED') === 'true' ||
      process.env.WHATSAPP_ENABLED === 'true'
    );
  }

  resolveWhatsAppFrom(): string | null {
    const raw =
      this.config.get<string>('TWILIO_WHATSAPP_FROM')?.trim() ||
      gatedProcessEnv('TWILIO_WHATSAPP_FROM', this.config);
    if (!raw) return null;
    return raw.startsWith('whatsapp:') ? raw : `whatsapp:${raw}`;
  }

  async sendWhatsAppPaymentLink(args: {
    phone: string;
    paymentLink: string;
    tenantId?: string;
    agentId?: string;
  }): Promise<{ ok: boolean; status: 'sent' | 'skipped' | 'failed'; messageSid?: string; error?: string }> {
    if (!this.isEnabled()) {
      return { ok: false, status: 'skipped', error: 'WhatsApp delivery is disabled.' };
    }

    this.logger.log(JSON.stringify({ event: 'whatsapp_attempted' }));

    const e164 = this.toE164(args.phone);
    if (!e164) {
      const error = 'Invalid phone number for WhatsApp.';
      this.logger.warn(JSON.stringify({ event: 'whatsapp_failed', error }));
      return { ok: false, status: 'failed', error };
    }

    const from = this.resolveWhatsAppFrom();
    if (!from) {
      const error = 'TWILIO_WHATSAPP_FROM is not configured.';
      this.logger.warn(JSON.stringify({ event: 'whatsapp_failed', error }));
      return { ok: false, status: 'failed', error };
    }

    let paymentLink: string;
    try {
      const url = new URL(args.paymentLink.trim());
      if (url.protocol !== 'https:') throw new Error('HTTPS required');
      paymentLink = url.toString();
    } catch {
      return { ok: false, status: 'failed', error: 'Invalid payment link URL.' };
    }

    const creds = await this.resolveTwilioCredentials(args.tenantId, args.agentId);
    if (!creds) {
      return { ok: false, status: 'failed', error: 'Twilio credentials are not configured.' };
    }

    const to = `whatsapp:${e164.replace(/^\+/, '+')}`;
    const body = `SureShot Books: Here is your secure payment link: ${paymentLink}`;

    try {
      const result = await this.twilioSms.sendSms({
        accountSid: creds.accountSid,
        authToken: creds.authToken,
        from,
        to,
        body,
      });
      this.logger.log(
        JSON.stringify({ event: 'whatsapp_sent', messageSid: result.sid ?? null }),
      );
      return { ok: true, status: 'sent', messageSid: result.sid };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const userFacingHint = classifyWhatsAppError(error);
      this.logger.warn(
        JSON.stringify({
          event: 'whatsapp_failed',
          error: error.slice(0, 400),
          hint: userFacingHint,
        }),
      );
      return { ok: false, status: 'failed', error: `${userFacingHint}: ${error.slice(0, 200)}` };
    }
  }

  private toE164(phone: string): string | null {
    const trimmed = phone.trim();
    const parsed = parsePhoneNumberFromString(trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/\D/g, '')}`);
    if (!parsed?.isValid()) return null;
    return parsed.format('E.164');
  }

  private async resolveTwilioCredentials(
    tenantId?: string,
    agentId?: string,
  ): Promise<{ accountSid: string; authToken: string } | null> {
    let accountSid: string | undefined;
    let authToken: string | undefined;

    if (tenantId && agentId) {
      const twilioCfg = await this.agents.getTwilioConfig(tenantId, agentId);
      accountSid = twilioCfg?.accountSid;
      authToken = twilioCfg?.authToken;
    }

    accountSid =
      accountSid ||
      this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim() ||
      gatedProcessEnv('TWILIO_ACCOUNT_SID', this.config);
    authToken =
      authToken ||
      this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim() ||
      gatedProcessEnv('TWILIO_AUTH_TOKEN', this.config);

    if (!accountSid || !authToken) return null;
    return { accountSid, authToken };
  }
}

function classifyWhatsAppError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('63016') || lower.includes('outside the allowed window')) {
    return 'WhatsApp session window expired; template may be required';
  }
  if (lower.includes('63003') || lower.includes('not registered on whatsapp')) {
    return 'Recipient is not on WhatsApp';
  }
  if (lower.includes('template')) {
    return 'WhatsApp template or approval issue';
  }
  return 'WhatsApp delivery error';
}
