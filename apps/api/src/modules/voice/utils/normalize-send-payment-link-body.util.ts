/**
 * ElevenLabs / Twilio tool payloads may use alternate field names for callSid and phone.
 */
export function pickString(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = body[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  }
  return undefined;
}

export function normalizeSendPaymentLinkFields(body: Record<string, unknown>): {
  callSid?: string;
  phoneNumber?: string;
} {
  return {
    callSid: pickString(body, ['callSid', 'call_sid', 'CallSid', 'conversation_call_sid']),
    phoneNumber: pickString(body, ['phoneNumber', 'phone', 'phone_number', 'caller_phone', 'From']),
  };
}
