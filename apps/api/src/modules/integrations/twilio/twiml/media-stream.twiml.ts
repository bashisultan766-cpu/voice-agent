import { escapeXml, escapeXmlAttribute } from './gather-mvp.twiml';
import { isVoiceMediaStreamEnabled } from '../../../realtime-voice/config/realtime-voice-flags.util';

export type MediaStreamTwiMLOptions = {
  /** Twilio stream track; inbound_track is required for caller audio on the websocket. */
  track?: 'inbound_track' | 'outbound_track' | 'both_tracks';
};

/**
 * Connect call to Media Streams WebSocket (streaming STT/TTS path).
 * Twilio Voice webhook must be HTTPS; this returns TwiML with wss:// stream URL.
 * @see https://www.twilio.com/docs/voice/twiml/stream
 */
export function buildMediaStreamConnectTwiML(
  websocketUrl: string,
  callSessionId: string,
  options?: MediaStreamTwiMLOptions,
): string {
  const url = escapeXmlAttribute(websocketUrl);
  const sessionParam = escapeXml(callSessionId);
  const track = options?.track ?? 'inbound_track';
  const trackAttr = ` track="${escapeXmlAttribute(track)}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${url}"${trackAttr}>
      <Parameter name="callSessionId" value="${sessionParam}" />
    </Stream>
  </Connect>
</Response>`;
}

export function isMediaStreamInboundEnabled(): boolean {
  return isVoiceMediaStreamEnabled();
}
