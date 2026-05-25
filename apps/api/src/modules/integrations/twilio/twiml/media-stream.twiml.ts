import { escapeXml, escapeXmlAttribute } from './gather-mvp.twiml';

/**
 * Connect call to Media Streams WebSocket (streaming STT/TTS path).
 * @see https://www.twilio.com/docs/voice/twiml/stream
 */
export function buildMediaStreamConnectTwiML(websocketUrl: string, callSessionId: string): string {
  const url = escapeXmlAttribute(websocketUrl);
  const sessionParam = escapeXml(callSessionId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${url}">
      <Parameter name="callSessionId" value="${sessionParam}" />
    </Stream>
  </Connect>
</Response>`;
}

export function isMediaStreamInboundEnabled(): boolean {
  return process.env.VOICE_MEDIA_STREAM_ENABLED === 'true';
}
