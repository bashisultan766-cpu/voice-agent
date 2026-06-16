import { Body, Controller, Logger, Post, Res } from '@nestjs/common';

import { SkipThrottle } from '@nestjs/throttler';

import { Response } from 'express';

import { z } from 'zod';

import { Public } from '../../../common/decorators/public.decorator';

import { buildFallbackTwiML } from '../twilio/twiml/conversation-relay.twiml';

import { InboundCallCaptureService } from '../../delivery/inbound-call-capture.service';

import { ElevenLabsTwilioRegisterCallService } from './elevenlabs-twilio-register-call.service';

import { LastTwimlDebugService } from './last-twiml-debug.service';
import { ReturningCallerService } from './returning-caller.service';
import { VoiceCallDiagnosticsService } from '../../voice/services/voice-call-diagnostics.service';
import { parseTwilioVoiceStatusBody } from '../../voice/utils/twilio-voice-status-callback.util';
import {
  isTwilioStreamWebSocketCloseError,
  TWILIO_STREAM_WEBSOCKET_CLOSE_EXPLANATION,
} from './utils/twilio-media-stream-error.util';



const twilioInboundBodySchema = z.object({

  From: z.string().trim().min(3),

  To: z.string().trim().min(3),

  CallSid: z.string().trim().min(5),

  Direction: z.string().trim().optional(),

});



/** Twilio voice webhooks time out around 15s — keep caller lookup under this budget. */

const CALLER_LOOKUP_BUDGET_MS = 3_500;



async function withInboundBudget<T>(

  promise: Promise<T>,

  budgetMs: number,

): Promise<{ value: T | null; timedOut: boolean }> {

  let timedOut = false;

  const value = await Promise.race([

    promise,

    new Promise<null>((resolve) => {

      setTimeout(() => {

        timedOut = true;

        resolve(null);

      }, budgetMs);

    }),

  ]);

  return { value, timedOut };

}



/**

 * Twilio → ElevenLabs Conversational AI register-call bridge.

 * Configure Twilio voice webhook: POST /api/elevenlabs/inbound
 * Configure call status changes: POST /api/elevenlabs/call-status
 *
 * Twilio error 31921 (Stream WebSocket Close) is a post-TwiML failure: Twilio
 * executes valid <Connect><Stream> TwiML, opens wss://api.elevenlabs.io, then
 * ElevenLabs closes the stream. That is not malformed backend XML — fix agent
 * publish, branch ID, phone import, or TTS μ-law 8000 Hz in ElevenLabs.
 */

@Controller('elevenlabs')

export class ElevenLabsTwilioController {

  private readonly logger = new Logger(ElevenLabsTwilioController.name);



  constructor(

    private readonly registerCall: ElevenLabsTwilioRegisterCallService,

    private readonly inboundCallCapture: InboundCallCaptureService,

    private readonly returningCaller: ReturningCallerService,

    private readonly callDiagnostics: VoiceCallDiagnosticsService,

    private readonly lastTwimlDebug: LastTwimlDebugService,

  ) {}

  @Public()
  @SkipThrottle()
  @Post('call-status')
  async callStatus(@Body() body: Record<string, string>, @Res() res: Response): Promise<void> {
    const parsed = parseTwilioVoiceStatusBody(body);
    if (!parsed) {
      this.logger.warn(
        JSON.stringify({
          event: 'elevenlabs.twilio.call_status_invalid_payload',
          keys: Object.keys(body ?? {}).slice(0, 12),
        }),
      );
      res.status(200).send('OK');
      return;
    }

    this.callDiagnostics.recordTwilioStatusCallback({
      callSid: parsed.CallSid,
      callStatus: parsed.CallStatus,
      callDuration: parsed.CallDuration,
      direction: parsed.Direction,
      from: parsed.From,
      to: parsed.To,
      errorCode: parsed.ErrorCode,
      errorMessage: parsed.ErrorMessage,
      streamError: parsed.StreamError,
      sipResponseCode: parsed.SipResponseCode,
      timestamp: parsed.Timestamp,
    });

    this.lastTwimlDebug.recordStatusCallback({
      callSid: parsed.CallSid,
      callStatus: parsed.CallStatus,
      errorCode: parsed.ErrorCode,
      errorMessage: parsed.ErrorMessage,
      streamError: parsed.StreamError,
      sipResponseCode: parsed.SipResponseCode,
      callDuration: parsed.CallDuration,
      timestamp: parsed.Timestamp,
    });

    const statusPayload = {
      event: 'elevenlabs.twilio.call_status',
      CallSid: parsed.CallSid,
      CallStatus: parsed.CallStatus,
      ErrorCode: parsed.ErrorCode ?? null,
      ErrorMessage: parsed.ErrorMessage?.slice(0, 300) ?? null,
      StreamError: parsed.StreamError?.slice(0, 300) ?? null,
      SipResponseCode: parsed.SipResponseCode ?? null,
      Timestamp: parsed.Timestamp ?? new Date().toISOString(),
      CallDuration: parsed.CallDuration ?? null,
    };

    this.logger.log(JSON.stringify(statusPayload));

    if (isTwilioStreamWebSocketCloseError(parsed.ErrorCode)) {
      this.logger.error(
        JSON.stringify({
          ...statusPayload,
          event: 'elevenlabs_stream_websocket_close_error',
          explanation: TWILIO_STREAM_WEBSOCKET_CLOSE_EXPLANATION,
          postTwimlLikelyIssue: this.lastTwimlDebug.isPostTwiml31921Issue(),
        }),
      );
    }

    res.status(200).send('OK');
  }

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

        event: 'inbound_call_received',

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

    this.callDiagnostics.recordCallStarted({
      callSid: CallSid,
      twilioCallStatus: 'ringing',
      callerPhoneMasked: maskPhoneForDiagnostics(From),
      toPhoneMasked: maskPhoneForDiagnostics(To),
      direction,
    });

    const inboundStarted = Date.now();



    void this.inboundCallCapture

      .captureInboundCall({ from: From, to: To, callSid: CallSid })

      .catch((captureErr: unknown) => {

        const captureMessage =

          captureErr instanceof Error ? captureErr.message : String(captureErr);

        this.logger.warn(

          JSON.stringify({

            event: 'elevenlabs.twilio.inbound_call_capture_failed',

            callSid: CallSid,

            message: captureMessage.slice(0, 300),

          }),

        );

      });



    let prepared = null as Awaited<ReturnType<ReturningCallerService['prepareInboundCall']>> | null;



    try {

      const lookupStarted = Date.now();

      const { value, timedOut } = await withInboundBudget(

        this.returningCaller.prepareInboundCall({ rawFrom: From, callSid: CallSid }),

        CALLER_LOOKUP_BUDGET_MS,

      );



      if (timedOut || !value) {

        this.logger.warn(

          JSON.stringify({

            event: 'caller_lookup_failed',

            callSid: CallSid,

            reason: timedOut ? 'twilio_budget_exceeded' : 'lookup_empty',

            budgetMs: CALLER_LOOKUP_BUDGET_MS,

            elapsedMs: Date.now() - lookupStarted,

          }),

        );

      } else {

        prepared = value;

      }

    } catch (lookupErr) {

      const lookupMessage = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);

      this.logger.warn(

        JSON.stringify({

          event: 'caller_lookup_failed',

          callSid: CallSid,

          message: lookupMessage.slice(0, 300),

        }),

      );

    }



    try {

      const twiml = await this.registerCall.registerInboundCall({
        fromNumber: From,
        toNumber: To,
        direction,
        callSid: CallSid,
        phoneNormalized: prepared?.phoneNormalized,
        initiation: prepared?.initiation,
      });

      const twimlBytes = twiml.length;
      this.callDiagnostics.recordRegisterCallResult({
        callSid: CallSid,
        success: true,
        httpStatus: 200,
        twimlBytes,
        latencyMs: Date.now() - inboundStarted,
      });
      this.callDiagnostics.recordTwimlSent({
        callSid: CallSid,
        twimlBytes,
        personalizedGreeting: prepared?.initiation.personalized ?? false,
        callerRecognized: prepared?.lookup.callerRecognized ?? false,
        totalElapsedMs: Date.now() - inboundStarted,
      });

      this.logger.log(
        JSON.stringify({
          event: 'elevenlabs.twilio.inbound_twiml_sent',
          callSid: CallSid,
          callerRecognized: prepared?.lookup.callerRecognized ?? false,
          personalizedGreeting: prepared?.initiation.personalized ?? false,
          totalElapsedMs: Date.now() - inboundStarted,
          twimlBytes,
          contentType: 'text/xml; charset=utf-8',
        }),
      );

      res.set('Content-Type', 'text/xml; charset=utf-8');
      res.status(200).send(twiml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.callDiagnostics.recordRegisterCallResult({
        callSid: CallSid,
        success: false,
        errorMessage: message,
        latencyMs: Date.now() - inboundStarted,
      });

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

function maskPhoneForDiagnostics(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}


