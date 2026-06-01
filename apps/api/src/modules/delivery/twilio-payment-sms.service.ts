import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { evaluateSmsCountryRules, readSmsCountryRulesFromEnv } from '../../config/smsCountryRules';
import { gatedProcessEnv } from '../../common/provider-env-slice.util';
import { TwilioSmsService } from '../integrations/twilio/twilio-sms.service';
import { AgentsService } from '../agents/agents.service';

const SMS_BODY_PREFIX = 'SureShot Books: Here is your secure payment link:';

@Injectable()
export class TwilioPaymentSmsService {
  private readonly logger = new Logger(TwilioPaymentSmsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly twilioSms: TwilioSmsService,
    private readonly agents: AgentsService,
  ) {}

  async hasTwilioCredentials(tenantId?: string, agentId?: string): Promise<boolean> {
    const creds = await this.resolveTwilioCredentials(tenantId, agentId);
    return creds !== null;
  }

  async sendSmsPaymentLink(args: {
    phone: string;
    paymentLink: string;
    tenantId?: string;
    agentId?: string;
  }): Promise<{ ok: boolean; status: 'sent' | 'skipped' | 'failed'; messageSid?: string; error?: string }> {
    const e164 = this.toE164(args.phone);
    if (!e164) {
      return { ok: false, status: 'failed', error: 'Invalid E.164 phone number.' };
    }

    const rules = readSmsCountryRulesFromEnv(process.env);
    const decision = evaluateSmsCountryRules(e164, rules);
    if (!decision.allowed) {
      return { ok: false, status: 'skipped', error: decision.reason };
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

    const body = `${SMS_BODY_PREFIX} ${paymentLink}`;

    try {
      const result = await this.twilioSms.sendSms({
        accountSid: creds.accountSid,
        authToken: creds.authToken,
        from: creds.from,
        to: e164,
        body,
      });
      return { ok: true, status: 'sent', messageSid: result.sid };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 'failed', error };
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
  ): Promise<{ accountSid: string; authToken: string; from: string } | null> {
    let accountSid: string | undefined;
    let authToken: string | undefined;
    let from: string | undefined;

    if (tenantId && agentId) {
      const twilioCfg = await this.agents.getTwilioConfig(tenantId, agentId);
      accountSid = twilioCfg?.accountSid;
      authToken = twilioCfg?.authToken;
      from = twilioCfg?.messagingFrom?.trim();
    }

    accountSid =
      accountSid ||
      this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim() ||
      gatedProcessEnv('TWILIO_ACCOUNT_SID', this.config);
    authToken =
      authToken ||
      this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim() ||
      gatedProcessEnv('TWILIO_AUTH_TOKEN', this.config);
    from =
      from ||
      this.config.get<string>('TWILIO_PHONE_NUMBER')?.trim() ||
      this.config.get<string>('TWILIO_MESSAGING_FROM')?.trim() ||
      this.twilioSms.defaultMessagingFrom() ||
      undefined;

    if (!accountSid || !authToken || !from) return null;
    return { accountSid, authToken, from };
  }
}
