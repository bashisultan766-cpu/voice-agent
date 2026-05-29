/**
 * Build TwiML for inbound voice: connect to ConversationRelay WebSocket.
 * MVP inbound calls should prefer `gather-mvp.twiml` (Say + Gather) until a WS server exists.
 * @see https://www.twilio.com/docs/voice/conversationrelay
 */
export function buildConversationRelayTwiML(websocketUrl: string): string {
  const encoded = encodeURIComponent(websocketUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${encoded}" />
  </Connect>
</Response>`;
}

/**
 * Fallback TwiML when no agent is found.
 * When `blockTwilioSay` is true, hang up silently (no Twilio TTS).
 */
export function buildFallbackTwiML(
  message?: string,
  options?: { blockTwilioSay?: boolean },
): string {
  if (options?.blockTwilioSay) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup />
</Response>`;
  }
  const say = message ?? "We're sorry, this line is not configured. Please try again later.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew" language="en-US">${escapeXml(say)}</Say>
  <Hangup />
</Response>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
