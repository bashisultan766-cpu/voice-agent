import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallsService } from '../../calls/calls.service';
import { isGatherFallbackEnabled } from '../config/realtime-voice-flags.util';

/**
 * When full-duplex Media Stream pipeline fails, redirect the live call to Gather MVP.
 */
@Injectable()
export class MediaStreamFallbackService {
  private readonly logger = new Logger(MediaStreamFallbackService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly callsService: CallsService,
  ) {}

  async redirectToGather(callSessionId: string, callSid: string, reason: string): Promise<void> {
    if (!isGatherFallbackEnabled()) {
      this.logger.warn(
        JSON.stringify({
          event: 'realtime.media_stream.fallback_disabled',
          callSessionId,
          callSid,
          reason,
        }),
      );
      return;
    }

    await this.callsService.mergeSessionMetadata(callSessionId, {
      mediaStreamFallback: true,
      mediaStreamFallbackReason: reason,
      fullDuplexPipeline: false,
    });

    const baseUrl = this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL')?.trim();
    if (!baseUrl || !callSid) {
      this.logger.error(
        JSON.stringify({
          event: 'realtime.media_stream.fallback_no_redirect',
          callSessionId,
          reason,
          note: 'Missing PUBLIC_WEBHOOK_BASE_URL or callSid — caller may hear silence until hangup',
        }),
      );
      return;
    }

    const gatherUrl = `${baseUrl.replace(/\/$/, '')}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(callSessionId)}`;

    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
      const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
      if (!accountSid || !authToken) {
        throw new Error('twilio_credentials_missing');
      }

      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">${this.escapeXml(gatherUrl)}</Redirect></Response>`;

      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
      const body = new URLSearchParams({ Twiml: twiml });
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`twilio_redirect_failed:${res.status}:${errText.slice(0, 200)}`);
      }

      this.logger.log(
        JSON.stringify({
          event: 'realtime.media_stream.fallback_to_gather',
          callSessionId,
          callSid,
          reason,
          gatherUrl,
        }),
      );
    } catch (err) {
      this.logger.error(
        JSON.stringify({
          event: 'realtime.media_stream.fallback_failed',
          callSessionId,
          callSid,
          reason,
          message: (err as Error).message,
        }),
      );
    }
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
