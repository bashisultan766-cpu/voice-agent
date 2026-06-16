import { z } from 'zod';

/** Twilio voice status callback body (form-urlencoded). */
export const twilioVoiceStatusCallbackSchema = z.object({
  CallSid: z.string().trim().min(1),
  CallStatus: z.string().trim().min(1),
  CallDuration: z.string().optional(),
  Direction: z.string().optional(),
  From: z.string().optional(),
  To: z.string().optional(),
  ErrorCode: z.string().optional(),
  ErrorMessage: z.string().optional(),
  /** Twilio Media Streams close detail when stream fails (e.g. 31921 WebSocket close). */
  StreamError: z.string().optional(),
  SipResponseCode: z.string().optional(),
  Timestamp: z.string().optional(),
});

export type TwilioVoiceStatusCallbackPayload = z.infer<typeof twilioVoiceStatusCallbackSchema>;

/**
 * Twilio Debugger shows 31921 for stream WebSocket close, but call-status POST
 * often omits ErrorCode on "completed" calls. Normalize any error-like fields.
 */
export function normalizeTwilioStatusErrorFields(
  body: Record<string, string>,
): Pick<TwilioVoiceStatusCallbackPayload, 'ErrorCode' | 'ErrorMessage' | 'StreamError'> {
  let errorCode =
    body.ErrorCode?.trim() ||
    body.error_code?.trim() ||
    body.StreamErrorCode?.trim() ||
    '';

  let errorMessage =
    body.ErrorMessage?.trim() ||
    body.error_message?.trim() ||
    body.StreamError?.trim() ||
    '';

  const streamError = body.StreamError?.trim() || body.StreamName?.trim() || '';

  if (!errorCode) {
    for (const [key, value] of Object.entries(body)) {
      if (!value?.trim()) continue;
      if (!/error|stream|debug/i.test(key)) continue;
      if (/\b31921\b/.test(value)) {
        errorCode = '31921';
        errorMessage = errorMessage || value.trim();
        break;
      }
    }
  }

  return {
    ErrorCode: errorCode || undefined,
    ErrorMessage: errorMessage || undefined,
    StreamError: streamError || undefined,
  };
}

export function parseTwilioVoiceStatusBody(
  body: Record<string, string>,
): TwilioVoiceStatusCallbackPayload | null {
  const normalizedErrors = normalizeTwilioStatusErrorFields(body);
  const merged = { ...body, ...normalizedErrors };
  const parsed = twilioVoiceStatusCallbackSchema.safeParse(merged);
  return parsed.success ? parsed.data : null;
}

/** Safe keys-only view for logs when debugging missing ErrorCode on short calls. */
export function listTwilioStatusCallbackKeys(body: Record<string, string>): string[] {
  return Object.keys(body ?? {}).sort();
}
