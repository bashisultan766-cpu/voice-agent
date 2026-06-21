import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import {
  createRedisClient,
  resolveRedisUrlFromConfig,
  safeRedisGet,
  safeRedisSetex,
} from '../../common/redis-client.util';
import { TranscriptBufferService } from '../calls/runtime/transcript-buffer.service';
import { CallsService } from '../calls/calls.service';
import {
  RAW_SESSION_REDIS_PREFIX,
  RAW_SESSION_TTL_SEC,
  type RawVoiceSession,
  type RawVoiceTurn,
} from './types/raw-session.types';

/**
 * Layer 1 — store full caller text in Redis + Postgres transcript.
 * Never truncates raw input.
 */
@Injectable()
export class RawInputCaptureService implements OnModuleDestroy {
  private readonly logger = new Logger(RawInputCaptureService.name);
  private readonly fallback = new Map<string, RawVoiceSession>();
  private redis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly transcriptBuffer: TranscriptBufferService,
    private readonly callsService: CallsService,
  ) {
    const url = resolveRedisUrlFromConfig((k) => this.config.get<string>(k));
    if (url) {
      const { client } = createRedisClient(url, this.logger, 'RawInputCapture');
      this.redis = client;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  private sessionKey(callSessionId: string): string {
    return `${RAW_SESSION_REDIS_PREFIX}${callSessionId}`;
  }

  async load(callSessionId: string): Promise<RawVoiceSession> {
    const raw = await safeRedisGet(this.redis, this.sessionKey(callSessionId));
    if (raw) {
      try {
        return JSON.parse(raw) as RawVoiceSession;
      } catch {
        /* fall through */
      }
    }
    return (
      this.fallback.get(callSessionId) ?? {
        callSessionId,
        turns: [],
        latestUserMessage: '',
        updatedAt: Date.now(),
      }
    );
  }

  private async persist(session: RawVoiceSession): Promise<void> {
    const serialized = JSON.stringify(session);
    const ok = await safeRedisSetex(
      this.redis,
      this.sessionKey(session.callSessionId),
      RAW_SESSION_TTL_SEC,
      serialized,
    );
    if (!ok) this.fallback.set(session.callSessionId, session);
  }

  /** Capture full user utterance before any normalization or compression. */
  async captureUserTurn(args: {
    callSessionId: string;
    rawText: string;
    persistTranscript?: boolean;
  }): Promise<RawVoiceSession> {
    const text = args.rawText;
    if (!text.trim()) return this.load(args.callSessionId);

    const current = await this.load(args.callSessionId);
    const turn: RawVoiceTurn = {
      turnId: randomUUID(),
      timestampMs: Date.now(),
      role: 'user',
      rawText: text,
    };
    const next: RawVoiceSession = {
      callSessionId: args.callSessionId,
      turns: [...current.turns, turn].slice(-48),
      latestUserMessage: text,
      latestAssistantMessage: current.latestAssistantMessage,
      updatedAt: Date.now(),
    };

    await this.persist(next);
    await this.callsService.mergeSessionMetadata(args.callSessionId, {
      rawVoiceSession: {
        latestUserMessageChars: text.length,
        turnCount: next.turns.length,
        lastCapturedAtMs: next.updatedAt,
      },
    });

    if (args.persistTranscript !== false) {
      const seq = await this.transcriptBuffer.getNextSequence(args.callSessionId);
      await this.transcriptBuffer.append(args.callSessionId, 'user', text, seq);
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.raw_input.captured',
        callSessionId: args.callSessionId,
        chars: text.length,
        turnCount: next.turns.length,
        redisReady: this.redis?.status === 'ready',
      }),
    );

    return next;
  }

  async captureAssistantTurn(args: {
    callSessionId: string;
    rawText: string;
    persistTranscript?: boolean;
  }): Promise<RawVoiceSession> {
    const text = args.rawText;
    const current = await this.load(args.callSessionId);
    const turn: RawVoiceTurn = {
      turnId: randomUUID(),
      timestampMs: Date.now(),
      role: 'assistant',
      rawText: text,
    };
    const next: RawVoiceSession = {
      ...current,
      turns: [...current.turns, turn].slice(-48),
      latestAssistantMessage: text,
      updatedAt: Date.now(),
    };
    await this.persist(next);

    if (args.persistTranscript !== false && text.trim()) {
      const seq = await this.transcriptBuffer.getNextSequence(args.callSessionId);
      await this.transcriptBuffer.append(args.callSessionId, 'agent', text, seq);
    }

    return next;
  }
}
