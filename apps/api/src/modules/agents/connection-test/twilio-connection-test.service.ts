import { Injectable } from '@nestjs/common';
import type { ConnectionTestResult } from './connection-test.types';
import { normalizePhoneNumber } from '../../integrations/twilio/utils/normalize-phone';

export interface TwilioTestConfig {
  twilioAccountSid?: string | null;
  twilioAuthToken?: string | null;
  twilioPhoneNumber?: string | null;
}

export interface TwilioIncomingPhoneConfig {
  sid: string;
  accountSid: string;
  phoneNumber: string;
  voiceUrl: string | null;
  voiceMethod: string | null;
  statusCallback: string | null;
  statusCallbackMethod: string | null;
}

/**
 * Validates and tests Twilio connection.
 * Replace the test logic in testConnection() with real Twilio API call
 * (e.g. fetch account or list phone numbers) to enable production testing.
 */
@Injectable()
export class TwilioConnectionTestService {
  private authHeader(config: TwilioTestConfig): string {
    const sid = config.twilioAccountSid!.trim();
    const token = config.twilioAuthToken!.trim();
    return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
  }

  private apiBase(config: TwilioTestConfig): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      config.twilioAccountSid!.trim(),
    )}`;
  }
  validateRequired(config: TwilioTestConfig): string | null {
    const sid = config.twilioAccountSid?.trim();
    const token = config.twilioAuthToken?.trim();
    if (!sid) return 'Twilio Account SID is required to test the connection.';
    if (!token) return 'Twilio Auth Token is required to test the connection.';
    return null;
  }

  /**
   * Run the connection test using Twilio REST API: fetch account details.
   */
  async testConnection(config: TwilioTestConfig): Promise<ConnectionTestResult> {
    const validationError = this.validateRequired(config);
    if (validationError) {
      return { success: false, message: validationError };
    }

    const sid = config.twilioAccountSid!.trim();
    const token = config.twilioAuthToken!.trim();
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      if (!res.ok) {
        const text = await res.text();
        return { success: false, message: `Twilio API returned ${res.status}: ${text.slice(0, 150)}` };
      }
      const data = (await res.json()) as { friendly_name?: string; status?: string };
      const name = data.friendly_name ?? sid;
      return { success: true, message: `Connected to Twilio account: ${name}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Twilio connection failed: ${message}` };
    }
  }

  /** Resolve Twilio IncomingPhoneNumber SID for an E.164 number on this account (or null). */
  async resolveIncomingPhoneSid(config: TwilioTestConfig): Promise<string | null> {
    const validationError = this.validateRequired(config);
    if (validationError) return null;
    const phoneRaw = config.twilioPhoneNumber?.trim();
    if (!phoneRaw) return null;
    const phone = normalizePhoneNumber(phoneRaw);
    const sid = config.twilioAccountSid!.trim();
    const token = config.twilioAuthToken!.trim();
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json`;
    const url = `${base}?PhoneNumber=${encodeURIComponent(phone)}`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
        },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { incoming_phone_numbers?: Array<{ sid?: string }> };
      const first = data.incoming_phone_numbers?.[0];
      return first?.sid?.trim() || null;
    } catch {
      return null;
    }
  }

  async getIncomingPhoneNumberConfig(config: TwilioTestConfig): Promise<TwilioIncomingPhoneConfig | null> {
    const validationError = this.validateRequired(config);
    if (validationError) return null;
    const phoneRaw = config.twilioPhoneNumber?.trim();
    if (!phoneRaw) return null;
    const phone = normalizePhoneNumber(phoneRaw);
    const url = `${this.apiBase(config)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: this.authHeader(config) },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        incoming_phone_numbers?: Array<{
          sid?: string;
          account_sid?: string;
          phone_number?: string;
          voice_url?: string | null;
          voice_method?: string | null;
          status_callback?: string | null;
          status_callback_method?: string | null;
        }>;
      };
      const row = data.incoming_phone_numbers?.[0];
      if (!row?.sid || !row?.account_sid || !row?.phone_number) return null;
      return {
        sid: row.sid,
        accountSid: row.account_sid,
        phoneNumber: row.phone_number,
        voiceUrl: row.voice_url ?? null,
        voiceMethod: row.voice_method ?? null,
        statusCallback: row.status_callback ?? null,
        statusCallbackMethod: row.status_callback_method ?? null,
      };
    } catch {
      return null;
    }
  }

  async updateIncomingPhoneNumberWebhook(
    config: TwilioTestConfig,
    opts: {
      incomingPhoneSid: string;
      voiceUrl: string;
      statusCallback: string;
      method?: 'POST' | 'GET';
    },
  ): Promise<{ success: boolean; message: string }> {
    const validationError = this.validateRequired(config);
    if (validationError) return { success: false, message: validationError };
    const method = opts.method ?? 'POST';
    const url = `${this.apiBase(config)}/IncomingPhoneNumbers/${encodeURIComponent(opts.incomingPhoneSid)}.json`;
    const body = new URLSearchParams({
      VoiceUrl: opts.voiceUrl,
      VoiceMethod: method,
      StatusCallback: opts.statusCallback,
      StatusCallbackMethod: method,
    });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(config),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text();
        return { success: false, message: `Twilio update failed ${res.status}: ${text.slice(0, 200)}` };
      }
      return { success: true, message: 'Twilio phone number webhook updated.' };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Twilio update request failed.',
      };
    }
  }
}
