/**
 * Twilio Media Streams error 31921 — "Stream - WebSocket - Close Error".
 *
 * This occurs **after** valid TwiML is returned: Twilio opens the ElevenLabs
 * wss:// stream, then ElevenLabs closes the WebSocket. It is not malformed
 * backend XML — check ElevenLabs agent publish state, branch ID, phone import,
 * and TTS format (μ-law 8000 Hz for Twilio).
 */
export const TWILIO_STREAM_WEBSOCKET_CLOSE_ERROR = '31921';

export const TWILIO_STREAM_WEBSOCKET_CLOSE_EXPLANATION =
  'Twilio opened ElevenLabs WebSocket but ElevenLabs closed the stream.';

export function isTwilioStreamWebSocketCloseError(errorCode: string | null | undefined): boolean {
  return errorCode?.trim() === TWILIO_STREAM_WEBSOCKET_CLOSE_ERROR;
}

export function isPostTwimlStreamIssue(args: {
  twimlHasStream: boolean;
  errorCode: string | null | undefined;
  callDurationSeconds?: number | null;
  callStatus?: string | null;
  quickDisconnectThresholdSeconds?: number;
}): boolean {
  if (!args.twimlHasStream) return false;
  if (isTwilioStreamWebSocketCloseError(args.errorCode)) return true;

  const threshold = args.quickDisconnectThresholdSeconds ?? 12;
  const duration = args.callDurationSeconds;
  const status = args.callStatus?.trim().toLowerCase() ?? '';
  const terminalQuick =
    (status === 'completed' || status === 'failed') &&
    duration != null &&
    duration >= 0 &&
    duration <= threshold;

  // Twilio 31921 often appears only in Debugger — not in call-status POST body.
  return terminalQuick;
}

export function inferTwilio31921FromStatus(args: {
  twimlHasStream: boolean;
  errorCode: string | null | undefined;
  callDurationSeconds?: number | null;
  callStatus?: string | null;
}): boolean {
  return (
    isTwilioStreamWebSocketCloseError(args.errorCode) ||
    isPostTwimlStreamIssue(args)
  );
}
