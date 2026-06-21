import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import {
  isLegacyVoiceWebSocketPath,
  LEGACY_VOICE_WEBSOCKET_PATHS,
  rejectLegacyVoiceWebSocketUpgrade,
} from './deprecated-voice-pipeline.util';

/**
 * Rejects WebSocket upgrades on retired NestJS Media Streams paths with HTTP 410.
 */
@Injectable()
export class LegacyVoiceWebSocketBlockerService implements OnModuleInit {
  private readonly logger = new Logger(LegacyVoiceWebSocketBlockerService.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    httpServer.on('upgrade', (request: IncomingMessage, socket: unknown, _head: Buffer) => {
      const url = request.url ?? '';
      if (!isLegacyVoiceWebSocketPath(url)) return;
      rejectLegacyVoiceWebSocketUpgrade(request, socket as Socket);
    });
    this.logger.warn(
      JSON.stringify({
        event: 'legacy_voice_ws_paths_blocked',
        paths: LEGACY_VOICE_WEBSOCKET_PATHS,
        activePipeline: 'services/voice-agent POST /voice/incoming → wss /ws/stream',
      }),
    );
  }
}
