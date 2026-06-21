import { HttpException, HttpStatus } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { Response } from 'express';

export const DEPRECATED_VOICE_PIPELINE_MESSAGE =
  'Deprecated: use services/voice-agent Media Streams pipeline';

/** HTTP handlers — throws 410 before legacy voice logic runs. */
export function rejectLegacyVoicePipeline(): never {
  throw new HttpException(DEPRECATED_VOICE_PIPELINE_MESSAGE, HttpStatus.GONE);
}

export function sendLegacyVoicePipelineGone(res: Response): void {
  res.status(HttpStatus.GONE).type('text/plain').send(DEPRECATED_VOICE_PIPELINE_MESSAGE);
}

/** Twilio Media Streams WebSocket paths retired from NestJS. */
export const LEGACY_VOICE_WEBSOCKET_PATHS = [
  '/api/twilio/voice/media-stream',
  '/api/realtime-voice/media-stream',
  '/api/realtime-voice/ws',
] as const;

export function isLegacyVoiceWebSocketPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return LEGACY_VOICE_WEBSOCKET_PATHS.some((prefix) => path.startsWith(prefix));
}

/** Reject WebSocket upgrade with HTTP 410 Gone. */
export function rejectLegacyVoiceWebSocketUpgrade(
  _request: IncomingMessage,
  socket: Socket,
): void {
  const body = DEPRECATED_VOICE_PIPELINE_MESSAGE;
  socket.write(
    `HTTP/1.1 410 Gone\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}
