/**
 * Minimal Twilio voice loop: fast inbound TwiML + gather redirect/reply helpers.
 * Twilio requires absolute URLs for Gather action and Redirect in most setups.
 */

export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value);
}

/** Sub-second inbound: Gather + Say only — no OpenAI/ElevenLabs. */
export function buildFastInboundTwiml(gatherActionAbsoluteUrl: string): string {
  const action = escapeXmlAttr(gatherActionAbsoluteUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" speechTimeout="auto">
    <Say>Hello! Welcome to our store. How can I help you today?</Say>
  </Gather>
</Response>`;
}

export function buildGatherNoSpeechTwiml(inboundAbsoluteUrl: string): string {
  const url = escapeXmlAttr(inboundAbsoluteUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>I did not hear you. Please say again.</Say>
  <Redirect method="POST">${url}</Redirect>
</Response>`;
}

export function buildGatherAiReplyTwiml(reply: string, inboundAbsoluteUrl: string): string {
  const said = escapeXmlText(reply);
  const url = escapeXmlAttr(inboundAbsoluteUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${said}</Say>
  <Redirect method="POST">${url}</Redirect>
</Response>`;
}

export function buildGatherErrorTwiml(message: string, inboundAbsoluteUrl: string): string {
  return buildGatherAiReplyTwiml(message, inboundAbsoluteUrl);
}
