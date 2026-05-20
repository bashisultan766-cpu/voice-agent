import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TwilioSmsService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Send SMS via Twilio REST API (2010-04-01).
   * Uses Basic auth with Account SID + Auth Token.
   */
  async sendSms(params: { accountSid: string; authToken: string; from: string; to: string; body: string }): Promise<{ sid?: string }> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.accountSid)}/Messages.json`;
    const body = new URLSearchParams({
      From: params.from,
      To: params.to,
      Body: params.body,
    });
    const auth = Buffer.from(`${params.accountSid}:${params.authToken}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Twilio SMS ${res.status}: ${text.slice(0, 200)}`);
    }
    try {
      const json = JSON.parse(text) as { sid?: string };
      return { sid: json.sid };
    } catch {
      return {};
    }
  }

  defaultMessagingFrom(): string | null {
    return this.config.get<string>('TWILIO_MESSAGING_FROM')?.trim() || null;
  }
}
