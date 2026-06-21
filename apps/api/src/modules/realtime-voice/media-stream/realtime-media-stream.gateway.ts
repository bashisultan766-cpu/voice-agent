import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  getRealtimePipelineFlags,
  isFullDuplexVoiceEnabled,
} from '../config/realtime-voice-flags.util';
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
    this.logger.warn(
      JSON.stringify({
        event: 'realtime.media_stream.gateway_deprecated',
        reason: 'voice_consolidated_to_services_voice_agent',
        blockedPath: this.pathPrefix,
        activePipeline: 'POST /voice/incoming → wss /ws/stream (services/voice-agent)',
      }),
    );
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
