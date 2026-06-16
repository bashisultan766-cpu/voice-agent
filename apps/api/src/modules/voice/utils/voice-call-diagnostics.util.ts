import {
  isTwilioStreamWebSocketCloseError,
  TWILIO_STREAM_WEBSOCKET_CLOSE_EXPLANATION,
} from '../../integrations/elevenlabs/utils/twilio-media-stream-error.util';

/** Seconds after TwiML — shorter calls likely failed during ElevenLabs media connect. */
export const QUICK_DISCONNECT_THRESHOLD_SECONDS = 12;

export const TERMINAL_TWILIO_CALL_STATUSES = new Set([
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
]);

export function maskPhoneForCallDiagnostics(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

export type LikelyFailureStage =
  | 'awaiting_twilio_status'
  | 'inbound_received'
  | 'register_call_failed'
  | 'twiml_sent'
  | 'twilio_initiated'
  | 'twilio_ringing'
  | 'twilio_in_progress'
  | 'twilio_completed'
  | 'twilio_completed_quick'
  | 'likely_post_twiml_disconnect'
  | 'twilio_failed'
  | 'twilio_busy'
  | 'twilio_no_answer'
  | 'twilio_canceled'
  | 'unknown';

export function inferLikelyFailureStage(args: {
  twimlSentAt: number | null;
  registerCallSuccess: boolean | null;
  twilioFinalStatus: string | null;
  callDurationSeconds: number | null;
  twilioErrorCode: string | null;
}): LikelyFailureStage {
  if (isTwilioStreamWebSocketCloseError(args.twilioErrorCode)) {
    return 'likely_post_twiml_disconnect';
  }

  const status = args.twilioFinalStatus?.toLowerCase() ?? null;

  if (status === 'failed') return 'twilio_failed';
  if (status === 'busy') return 'twilio_busy';
  if (status === 'no-answer') return 'twilio_no_answer';
  if (status === 'canceled') return 'twilio_canceled';
  if (status === 'initiated') return 'twilio_initiated';
  if (status === 'ringing') return 'twilio_ringing';
  if (status === 'in-progress' || status === 'answered') return 'twilio_in_progress';

  if (status === 'completed') {
    const duration = args.callDurationSeconds;
    if (
      args.twimlSentAt &&
      duration != null &&
      duration >= 0 &&
      duration <= QUICK_DISCONNECT_THRESHOLD_SECONDS
    ) {
      return 'likely_post_twiml_disconnect';
    }
    return duration != null && duration <= QUICK_DISCONNECT_THRESHOLD_SECONDS
      ? 'twilio_completed_quick'
      : 'twilio_completed';
  }

  if (args.registerCallSuccess === false) return 'register_call_failed';
  if (args.twimlSentAt) return 'awaiting_twilio_status';
  if (args.registerCallSuccess === true) return 'twiml_sent';
  return 'inbound_received';
}

export function buildLikelyDisconnectReason(stage: LikelyFailureStage, args: {
  twilioErrorCode: string | null;
  twilioErrorMessage: string | null;
  callDurationSeconds: number | null;
  registerCallSuccess: boolean | null;
}): string {
  if (isTwilioStreamWebSocketCloseError(args.twilioErrorCode)) {
    return `${TWILIO_STREAM_WEBSOCKET_CLOSE_EXPLANATION} Twilio error 31921 — check ElevenLabs agent publish, branch ID, phone import, and TTS μ-law 8000 Hz.`;
  }
  if (args.twilioErrorMessage?.trim()) {
    return args.twilioErrorMessage.trim().slice(0, 240);
  }
  if (args.twilioErrorCode?.trim()) {
    return `Twilio error code ${args.twilioErrorCode.trim()}.`;
  }

  switch (stage) {
    case 'register_call_failed':
      return 'ElevenLabs register-call failed before TwiML was returned to Twilio.';
    case 'likely_post_twiml_disconnect':
    case 'twilio_completed_quick':
      return `Call ended within ${args.callDurationSeconds ?? 0}s after TwiML was sent — likely Twilio↔ElevenLabs media connect failure, missing ElevenLabs phone import, or geo restriction.`;
    case 'twilio_failed':
      return 'Twilio reported call failed.';
    case 'twilio_busy':
      return 'Twilio reported line busy.';
    case 'twilio_no_answer':
      return 'Twilio reported no answer.';
    case 'twilio_canceled':
      return 'Twilio reported call canceled.';
    case 'awaiting_twilio_status':
      return 'TwiML was sent; waiting for Twilio status callback. Configure Call status changes webhook on the Twilio number.';
    case 'twiml_sent':
      return 'TwiML sent to Twilio; no terminal status received yet.';
    default:
      return 'Insufficient diagnostic data — check Twilio call logs and ElevenLabs conversation history.';
  }
}
