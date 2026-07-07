/**
 * Twilio Media Streams WebSocket protocol types.
 * @see https://www.twilio.com/docs/voice/media-streams/websocket-messages
 */

export interface MediaStreamStartMessage {
  event: "start";
  sequenceNumber: string;
  start: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: { encoding: string; sampleRate: number; channels: number };
    customParameters?: Record<string, string>;
  };
  streamSid: string;
}

export interface MediaStreamMediaMessage {
  event: "media";
  sequenceNumber: string;
  media: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
  streamSid: string;
}

export interface MediaStreamStopMessage {
  event: "stop";
  sequenceNumber: string;
  stop: { accountSid: string; callSid: string };
  streamSid: string;
}

export interface MediaStreamConnectedMessage {
  event: "connected";
  protocol: string;
  version: string;
}

export type MediaStreamInboundMessage =
  | MediaStreamConnectedMessage
  | MediaStreamStartMessage
  | MediaStreamMediaMessage
  | MediaStreamStopMessage
  | { event: string; streamSid?: string };

export type MediaStreamOutboundMessage =
  | { event: "media"; streamSid: string; media: { payload: string } }
  | { event: "mark"; streamSid: string; mark: { name: string } }
  | { event: "clear"; streamSid: string }
  | { event: "stop"; streamSid: string };
