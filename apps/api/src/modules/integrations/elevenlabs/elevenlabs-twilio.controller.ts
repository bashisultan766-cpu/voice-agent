import { Body, Controller, Logger, Post, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { z } from 'zod';
import { Public } from '../../../common/decorators/public.decorator';
import { buildFallbackTwiML } from '../twilio/twiml/conversation-relay.twiml';
import { InboundCallCaptureService } from '../../delivery/inbound-call-capture.service';
import { ElevenLabsTwilioRegisterCallService } from './elevenlabs-twilio-register-call.service';

const twilioInboundBodySchema = z.object({
  From: z.string().trim().min(3),
  To: z.string().trim().min(3),
  CallSid: z.string().trim().min(5),
  Direction: z.string().trim().optional(),
});

/**
 * Twilio → ElevenLabs Conversational AI register-call bridge.
 * Configure Twilio voice webhook: POST /api/elevenlabs/inbound
 */
@Controller('elevenlabs')
export class ElevenLabsTwilioController {
  private readonly logger = new Logger(ElevenLabsTwilioController.name);

  constructor(
    private readonly registerCall: ElevenLabsTwilioRegisterCallService,
    private readonly inboundCallCapture: InboundCallCaptureService,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('inbound')
  async inbound(@Body() body: Record<string, string>, @Res() res: Response): Promise<void> {
    const sendFallback = (reason: string, callSid?: string | null) => {
      this.logger.warn(
        JSON.stringify({
          event: 'elevenlabs.twilio.inbound_fallback',
          reason,
          callSid: callSid ?? null,
        }),
      );
      const fallback = buildFallbackTwiML(
        "We're sorry, we're unable to connect your call right now. Please try again later.",
      );
      res.type('text/xml; charset=utf-8');
      res.status(200).send(fallback);
    };

    this.logger.log(
      JSON.stringify({
        event: 'elevenlabs.twilio.inbound_received',
        hasFrom: Boolean(body?.From),
        hasTo: Boolean(body?.To),
        callSid: body?.CallSid ?? null,
      }),
    );

    const parsed = twilioInboundBodySchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(
        JSON.stringify({
          event: 'elevenlabs.twilio.inbound_invalid_payload',
          issues: parsed.error.flatten().fieldErrors,
        }),
      );
      sendFallback('invalid_payload', body?.CallSid);
      return;
    }

    const { From, To, CallSid, Direction } = parsed.data;
    const direction =
      Direction?.toLowerCase() === 'outbound' ? ('outbound' as const) : ('inbound' as const);

    try {
      await this.inboundCallCapture.captureInboundCall({
        from: From,
        to: To,
        callSid: CallSid,
      });
      this.logger.log(
        JSON.stringify({
          event: 'elevenlabs.twilio.inbound_call_captured',
          callSid: CallSid,
          fromMasked: From.replace(/\d(?=\d{4})/g, '*'),
        }),
      );
    } catch (captureErr) {
      const captureMessage = captureErr instanceof Error ? captureErr.message : String(captureErr);
      this.logger.warn(
        JSON.stringify({
          event: 'elevenlabs.twilio.inbound_call_capture_failed',
          callSid: CallSid,
          message: captureMessage.slice(0, 300),
        }),
      );
    }

    try {
      const twiml = await this.registerCall.registerInboundCall({
        fromNumber: From,
        toNumber: To,
        direction,
        callSid: CallSid,
      });

      res.type('text/xml; charset=utf-8');
      res.send(twiml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({
          event: 'elevenlabs.twilio.inbound_error',
          callSid: CallSid ?? null,
          message: message.slice(0, 500),
        }),
      );

      sendFallback(message.slice(0, 120), CallSid);
    }
  }
}
