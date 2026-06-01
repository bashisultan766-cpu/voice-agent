import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { detectPhoneCountry } from '../../config/smsCountryRules';
import { normalizePhoneNumber } from '../integrations/twilio/utils/normalize-phone';

@Injectable()
export class InboundCallCaptureService {
  private readonly logger = new Logger(InboundCallCaptureService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist Twilio inbound caller metadata for payment-link SMS/WhatsApp lookup.
   */
  async captureInboundCall(args: {
    from: string;
    to: string;
    callSid: string;
  }): Promise<{ id: string; callerPhone: string; callerCountry: string | null }> {
    const callerPhone = normalizePhoneNumber(args.from);
    const twilioNumber = normalizePhoneNumber(args.to);
    const callerCountry = detectPhoneCountry(callerPhone || args.from);

    const row = await this.prisma.inboundCall.upsert({
      where: { callSid: args.callSid },
      create: {
        callSid: args.callSid,
        callerPhone: callerPhone || args.from.trim(),
        twilioNumber: twilioNumber || args.to.trim(),
        callerCountry,
      },
      update: {
        callerPhone: callerPhone || args.from.trim(),
        twilioNumber: twilioNumber || args.to.trim(),
        callerCountry,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'inbound_call_captured',
        callSid: args.callSid,
        callerCountry,
        inboundCallId: row.id,
      }),
    );

    return {
      id: row.id,
      callerPhone: row.callerPhone,
      callerCountry: row.callerCountry,
    };
  }

  async findCallerPhoneByCallSid(callSid: string): Promise<string | null> {
    const row = await this.prisma.inboundCall.findUnique({
      where: { callSid },
      select: { callerPhone: true },
    });
    if (!row?.callerPhone) {
      this.logger.warn(
        JSON.stringify({
          event: 'inbound_call.lookup_miss',
          callSid,
        }),
      );
      return null;
    }
    return row.callerPhone;
  }
}
