import type { WebSocket } from 'ws';

export const WS_OPEN = 1;

/** Collects outbound Twilio Media Stream frames for assertions. */
export class MockTwilioMediaStreamWs {
  readonly sent: string[] = [];
  readyState = WS_OPEN;
  /** Match ws WebSocket.OPEN for production readyState checks. */
  readonly OPEN = WS_OPEN;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  parseSent(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  mediaPayloads(): string[] {
    return this.parseSent()
      .filter((m) => m.event === 'media')
      .map((m) => (m.media as { payload: string }).payload);
  }

  clearEvents(): number {
    return this.parseSent().filter((m) => m.event === 'clear').length;
  }

  markEvents(): Array<{ name: string }> {
    return this.parseSent()
      .filter((m) => m.event === 'mark')
      .map((m) => m.mark as { name: string });
  }
}

export function twilioConnectedEvent(): string {
  return JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });
}

export function twilioStartEvent(opts: {
  streamSid: string;
  callSid: string;
  callSessionId: string;
}): string {
  return JSON.stringify({
    event: 'start',
    streamSid: opts.streamSid,
    start: {
      streamSid: opts.streamSid,
      callSid: opts.callSid,
      customParameters: { callSessionId: opts.callSessionId },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  });
}

export function twilioInboundMediaEvent(payload = 'dGVzdA=='): string {
  return JSON.stringify({
    event: 'media',
    media: { track: 'inbound', payload, chunk: '1', timestamp: '100' },
  });
}

export function twilioStopEvent(): string {
  return JSON.stringify({ event: 'stop' });
}

export function twilioMarkEvent(name: string): string {
  return JSON.stringify({ event: 'mark', mark: { name } });
}

/** Minimal mulaw silence frame (base64). */
export const SAMPLE_MULAW_B64 = '////////////////////////////////////////////////////////////////';
