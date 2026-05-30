export type TwilioMediaStreamEvent =
  | 'connected'
  | 'start'
  | 'media'
  | 'mark'
  | 'stop'
  | 'clear'
  | 'dtmf';

export type TwilioInboundMessage = {
  event?: TwilioMediaStreamEvent | string;
  streamSid?: string;
  sequenceNumber?: string;
  start?: {
    streamSid?: string;
    callSid?: string;
    accountSid?: string;
    customParameters?: Record<string, string>;
    mediaFormat?: { encoding?: string; sampleRate?: number; channels?: number };
  };
  media?: {
    track?: string;
    chunk?: string;
    timestamp?: string;
    payload?: string;
  };
  mark?: { name?: string };
};

export type TwilioOutboundMedia = {
  event: 'media';
  streamSid: string;
  media: { payload: string };
};

export type TwilioOutboundMark = {
  event: 'mark';
  streamSid: string;
  mark: { name: string };
};

export type TwilioOutboundClear = {
  event: 'clear';
  streamSid: string;
};

export function parseTwilioMediaMessage(raw: string): TwilioInboundMessage | null {
  try {
    return JSON.parse(raw) as TwilioInboundMessage;
  } catch {
    return null;
  }
}

export function buildTwilioMediaPayload(streamSid: string, mulawBase64: string): string {
  const msg: TwilioOutboundMedia = {
    event: 'media',
    streamSid,
    media: { payload: mulawBase64 },
  };
  return JSON.stringify(msg);
}

export function buildTwilioMarkPayload(streamSid: string, name: string): string {
  const msg: TwilioOutboundMark = {
    event: 'mark',
    streamSid,
    mark: { name },
  };
  return JSON.stringify(msg);
}

export function buildTwilioClearPayload(streamSid: string): string {
  const msg: TwilioOutboundClear = { event: 'clear', streamSid };
  return JSON.stringify(msg);
}

export function extractCallSessionId(msg: TwilioInboundMessage, queryParam?: string): string {
  const fromQuery = queryParam?.trim();
  if (fromQuery) return fromQuery;
  const fromStart = msg.start?.customParameters?.callSessionId?.trim();
  if (fromStart) return fromStart;
  return '';
}

export function isInboundMulawMedia(msg: TwilioInboundMessage): boolean {
  return msg.event === 'media' && msg.media?.track === 'inbound' && Boolean(msg.media.payload?.length);
}

/** Split assistant text into speakable chunks for streaming TTS. */
export function splitTextForStreamingTts(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^.!?]+[.!?]?/g) ?? [trimmed];
  return parts.map((p) => p.trim()).filter(Boolean);
}
