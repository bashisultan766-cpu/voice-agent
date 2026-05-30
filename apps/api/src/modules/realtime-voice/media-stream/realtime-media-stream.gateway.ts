import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { isFullDuplexVoiceEnabled } from '../config/realtime-voice-flags.util';
import { FullDuplexPipelineService } from './full-duplex-pipeline.service';
import {
  extractCallSessionId,
  isInboundMulawMedia,
  parseTwilioMediaMessage,
} from './twilio-media-protocol.util';

/**
 * Twilio Media Streams WebSocket — full-duplex path at /api/realtime-voice/media-stream.
 * Twilio events: connected, start, media, mark, stop.
 */
@Injectable()
export class RealtimeMediaStreamGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeMediaStreamGateway.name);
  private wss: WebSocketServer | null = null;
  private readonly pathPrefix = '/api/realtime-voice/media-stream';

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly pipeline: FullDuplexPipelineService,
  ) {}

  onModuleInit(): void {
    if (!isFullDuplexVoiceEnabled()) {
      this.logger.log(
        'Full-duplex media stream gateway disabled (requires VOICE_MEDIA_STREAM_ENABLED + OPENAI_REALTIME_ENABLED + REALTIME_MULTI_AGENT_ENABLED)',
      );
      return;
    }

    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();

    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request: IncomingMessage, socket: unknown, head: Buffer) => {
      const url = request.url ?? '';
      if (!url.startsWith(this.pathPrefix)) return;
      this.wss?.handleUpgrade(request, socket as import('net').Socket, head, (ws) => {
        this.wss?.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      void this.handleConnection(ws, req);
    });

    this.logger.log(JSON.stringify({ event: 'realtime.media_stream.ws_ready', path: this.pathPrefix }));
  }

  onModuleDestroy(): void {
    this.wss?.close();
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const querySessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('callSessionId') ?? '';
    let callSessionId = querySessionId.trim();
    let streamSid = '';
    let callSid = '';

    this.logger.log(
      JSON.stringify({
        event: 'realtime.media_stream.connected',
        callSessionId: callSessionId || undefined,
      }),
    );

    ws.on('message', (raw) => {
      void (async () => {
        const msg = parseTwilioMediaMessage(String(raw));
        if (!msg) return;

        if (msg.event === 'connected') {
          await this.pipeline.onTwilioConnected(ws, callSessionId, querySessionId);
          return;
        }

        if (msg.event === 'start' && msg.start) {
          streamSid = msg.streamSid ?? msg.start.streamSid ?? '';
          callSid = msg.start.callSid ?? '';
          callSessionId = extractCallSessionId(msg, querySessionId) || callSessionId;
          if (callSessionId && streamSid) {
            await this.pipeline.onTwilioStart(ws, callSessionId, streamSid, callSid);
          }
          return;
        }

        if (isInboundMulawMedia(msg) && callSessionId) {
          this.pipeline.onTwilioMedia(callSessionId, msg.media!.payload!);
          return;
        }

        if (msg.event === 'mark' && callSessionId) {
          // Playback mark received — chunk finished playing on Twilio side
          return;
        }

        if (msg.event === 'stop' && callSessionId) {
          await this.pipeline.onTwilioStop(callSessionId);
        }
      })();
    });

    ws.on('close', () => {
      if (callSessionId) void this.pipeline.onTwilioClose(callSessionId);
    });

    ws.on('error', (err) => {
      this.logger.warn(
        JSON.stringify({
          event: 'realtime.media_stream.ws_error',
          callSessionId,
          message: (err as Error).message,
        }),
      );
      if (callSessionId) void this.pipeline.onTwilioClose(callSessionId);
    });
  }
}
