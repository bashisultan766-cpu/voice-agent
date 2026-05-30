import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { CallsService } from '../../calls/calls.service';
import { VoiceStreamMetricsService } from '../../calls/runtime/voice-stream-metrics.service';
import { VoiceStreamingSessionService } from '../../calls/runtime/voice-streaming-session.service';
import {
  isFullDuplexVoiceEnabled,
  isLegacyMediaStreamEnabled,
  isVoiceMediaStreamEnabled,
} from '../../realtime-voice/config/realtime-voice-flags.util';

type TwilioStreamMessage = {
  event?: string;
  streamSid?: string;
  start?: { callSid?: string; customParameters?: Record<string, string> };
  media?: { payload?: string; track?: string };
  mark?: { name?: string };
};

/**
 * Twilio Media Streams WebSocket — bidirectional audio path toward streaming STT/TTS.
 * Enable with VOICE_MEDIA_STREAM_ENABLED=true and inbound TwiML <Connect><Stream>.
 */
@Injectable()
export class TwilioMediaStreamService implements OnModuleInit {
  private readonly logger = new Logger(TwilioMediaStreamService.name);
  private wss: WebSocketServer | null = null;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly callsService: CallsService,
    private readonly streamMetrics: VoiceStreamMetricsService,
    private readonly streamingSession: VoiceStreamingSessionService,
  ) {}

  onModuleInit(): void {
    if (isFullDuplexVoiceEnabled()) {
      this.logger.log(
        JSON.stringify({
          event: 'twilio.legacy_media_stream_gateway_skipped',
          reason: 'full_duplex_active',
          usePath: '/api/realtime-voice/media-stream',
        }),
      );
      return;
    }
    if (!isVoiceMediaStreamEnabled() && !isLegacyMediaStreamEnabled()) {
      this.logger.log(
        JSON.stringify({
          event: 'twilio.legacy_media_stream_gateway_disabled',
          reason: 'VOICE_MEDIA_STREAM_ENABLED not truthy',
        }),
      );
      return;
    }
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    this.wss = new WebSocketServer({ noServer: true });
    const pathPrefix = '/api/twilio/voice/media-stream';

    httpServer.on('upgrade', (request: IncomingMessage, socket: unknown, head: Buffer) => {
      const url = request.url ?? '';
      if (!url.startsWith(pathPrefix)) return;
      this.wss?.handleUpgrade(request, socket as import('net').Socket, head, (ws) => {
        this.wss?.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      void this.handleConnection(ws, req);
    });

    this.logger.log(JSON.stringify({ event: 'twilio.media_stream.ws_ready', pathPrefix }));
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const params = new URL(req.url ?? '', 'http://localhost').searchParams;
    const callSessionId = params.get('callSessionId')?.trim() ?? '';
    let streamSid: string | null = null;

    if (callSessionId) {
      await this.streamMetrics.merge(callSessionId, {
        streamingMode: 'media_stream',
        streamingStatus: 'listening',
      });
    }

    ws.on('message', (raw) => {
      void (async () => {
        try {
          const msg = JSON.parse(String(raw)) as TwilioStreamMessage;
          if (msg.event === 'start' && msg.start) {
            streamSid = msg.streamSid ?? null;
            if (callSessionId && streamSid) {
              await this.callsService.mergeSessionMetadata(callSessionId, {
                twilioStreamSid: streamSid,
                mediaStreamConnected: true,
              });
            }
            this.logger.log(
              JSON.stringify({
                event: 'twilio.media_stream.start',
                callSessionId,
                streamSid,
              }),
            );
          }
          if (msg.event === 'media' && msg.media?.track === 'inbound' && callSessionId) {
            const payload = msg.media.payload ?? '';
            if (payload.length > 0) {
              const meta = await this.callsService.findOneById(callSessionId);
              const m = (meta.metadata ?? {}) as Record<string, unknown>;
              if (m.agentSpeaking === true) {
                await this.streamingSession.cancelDeferredJobForBargeIn(callSessionId);
              }
            }
          }
          if (msg.event === 'mark' && callSessionId) {
            await this.streamMetrics.markSpeaking(callSessionId, true);
          }
          if (msg.event === 'stop' && callSessionId) {
            await this.streamMetrics.merge(callSessionId, {
              streamingStatus: 'idle',
              agentSpeaking: false,
            });
          }
        } catch {
          // ignore malformed frames
        }
      })();
    });

    ws.on('close', () => {
      if (callSessionId) {
        void this.streamMetrics.merge(callSessionId, { streamingStatus: 'idle', agentSpeaking: false });
      }
    });
  }
}
