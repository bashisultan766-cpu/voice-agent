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

export function parseTwilioVoiceStatusBody(
  body: Record<string, string>,
): TwilioVoiceStatusCallbackPayload | null {
  const parsed = twilioVoiceStatusCallbackSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
