import { escapeXml } from './xml';

export type InboundTwiMLOptions = {
  greetingSpeech: string;
  relayWebSocketUrl: string;
  welcomeGreeting?: string;
  connectActionUrl?: string;
};

/**
 * Speaks a short greeting, then hands off to ConversationRelay for realtime STT/TTS + our WebSocket agent.
 */
export function buildInboundVoiceTwiML(opts: InboundTwiMLOptions): string {
  const welcome = opts.welcomeGreeting ?? 'How can I help you today?';
  const actionAttr = opts.connectActionUrl
    ? ` action="${escapeXml(opts.connectActionUrl)}"`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escapeXml(opts.greetingSpeech)}</Say>
  <Connect${actionAttr}>
    <ConversationRelay url="${escapeXml(opts.relayWebSocketUrl)}" welcomeGreeting="${escapeXml(
      welcome,
    )}" interruptible="true" />
  </Connect>
</Response>`;
}
