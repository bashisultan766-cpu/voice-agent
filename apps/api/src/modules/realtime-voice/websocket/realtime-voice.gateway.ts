import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'http';
import { VoiceEventBusService } from '../events/voice-event-bus.service';
import { RealtimeVoiceOrchestratorService } from '../orchestrator/realtime-voice-orchestrator.service';

type ClientMessage =
  | { type: 'turn'; callSessionId: string; utterance: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }
  | { type: 'subscribe'; callSessionId: string }
  | { type: 'interrupt'; callSessionId: string };

/**
 * WebSocket gateway at /api/realtime-voice/ws for live turn streaming and event fan-out.
 */
@Injectable()
export class RealtimeVoiceGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeVoiceGateway.name);
  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  private unsubEvents: (() => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly orchestrator: RealtimeVoiceOrchestratorService,
    private readonly events: VoiceEventBusService,
  ) {}

  onModuleInit(): void {
    this.unsubEvents = this.events.on('stream.chunk', (event) => {
      this.broadcast(event.payload.callSessionId, { type: 'stream.chunk', ...event.payload });
    });
  }

  onModuleDestroy(): void {
    this.unsubEvents?.();
    this.wss?.close();
  }

  attach(server: Server): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ server, path: '/api/realtime-voice/ws' });
    this.wss.on('connection', (ws) => {
      this.subscriptions.set(ws, new Set());
      ws.on('message', (raw) => void this.handleMessage(ws, raw.toString()));
      ws.on('close', () => this.subscriptions.delete(ws));
    });
    this.logger.log('Realtime voice WebSocket gateway attached at /api/realtime-voice/ws');
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid_json' }));
      return;
    }

    if (msg.type === 'subscribe') {
      this.subscriptions.get(ws)?.add(msg.callSessionId);
      ws.send(JSON.stringify({ type: 'subscribed', callSessionId: msg.callSessionId }));
      return;
    }

    if (msg.type === 'interrupt') {
      this.broadcast(msg.callSessionId, { type: 'interrupt.ack', callSessionId: msg.callSessionId });
      return;
    }

    if (msg.type === 'turn') {
      const result = await this.orchestrator.processUtterance(
        msg.callSessionId,
        msg.utterance,
        msg.history ?? [],
      );
      ws.send(JSON.stringify({ type: 'turn.result', ...result }));
    }
  }

  private broadcast(callSessionId: string, payload: Record<string, unknown>): void {
    if (!this.wss) return;
    const data = JSON.stringify(payload);
    for (const [ws, sessions] of this.subscriptions) {
      if (sessions.has(callSessionId) && ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }
}
