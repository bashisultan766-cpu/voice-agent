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
}): boolean {
  return args.twimlHasStream && isTwilioStreamWebSocketCloseError(args.errorCode);
}
