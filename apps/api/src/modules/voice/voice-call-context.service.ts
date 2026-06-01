import { Injectable, Logger } from '@nestjs/common';
import { InboundCallCaptureService } from '../delivery/inbound-call-capture.service';

export type ResolvedCallIdentifiers = {
  callSid: string | null;
  phoneNumber: string | null;
  country: string | null;
  source: 'request' | 'calls_table' | 'recent_inbound' | 'none';
};

@Injectable()
export class VoiceCallContextService {
  private readonly logger = new Logger(VoiceCallContextService.name);

  constructor(private readonly inboundCalls: InboundCallCaptureService) {}

  async resolveForPaymentLink(args: {
    callSid?: string | null;
    phoneNumber?: string | null;
  }): Promise<ResolvedCallIdentifiers> {
    let callSid = args.callSid?.trim() || null;
    let phoneNumber = args.phoneNumber?.trim() || null;
    let country: string | null = null;
    let source: ResolvedCallIdentifiers['source'] = 'none';

    if (phoneNumber) {
      this.logger.log(JSON.stringify({ event: 'payment.tool.phoneNumber_received' }));
      source = 'request';
    }

    if (callSid) {
      this.logger.log(JSON.stringify({ event: 'payment.tool.callSid_received', callSid }));
      if (!phoneNumber) source = 'request';
    }

    if (!phoneNumber && callSid) {
      this.logger.log(JSON.stringify({ event: 'delivery.phone_lookup_started', callSid }));
      const row = await this.inboundCalls.findInboundCallByCallSid(callSid);
      if (row?.callerPhone) {
        phoneNumber = row.callerPhone;
        country = row.callerCountry;
        source = 'calls_table';
        this.logger.log(
          JSON.stringify({
            event: 'delivery.phone_lookup_success',
            callSid,
            source: 'calls_table',
          }),
        );
      } else {
        this.logger.warn(
          JSON.stringify({
            event: 'delivery.phone_lookup_failed',
            callSid,
            reason: 'no_calls_row',
          }),
        );
      }
    }

    if (!phoneNumber && !callSid) {
      this.logger.log(
        JSON.stringify({
          event: 'delivery.phone_lookup_started',
          reason: 'recent_inbound_fallback',
        }),
      );
      const recent = await this.inboundCalls.findRecentInboundCall();
      if (recent) {
        callSid = recent.callSid;
        phoneNumber = recent.callerPhone;
        country = recent.callerCountry;
        source = 'recent_inbound';
        this.logger.log(
          JSON.stringify({
            event: 'delivery.phone_lookup_success',
            callSid,
            source: 'recent_inbound',
          }),
        );
      } else {
        this.logger.warn(
          JSON.stringify({
            event: 'delivery.phone_lookup_failed',
            reason: 'no_recent_inbound_call',
          }),
        );
      }
    }

    if (!phoneNumber && !callSid) {
      this.logger.warn(JSON.stringify({ event: 'delivery.phone_missing' }));
    }

    return { callSid, phoneNumber, country, source };
  }
}
