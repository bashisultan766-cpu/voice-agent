import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  createRedisClient,
  resolveRedisUrlFromConfig,
  safeRedisGet,
  safeRedisSetex,
} from '../../../common/redis-client.util';
import type { ConversationTurn, VoiceIntent } from '../types/voice-turn.types';
import type { VoiceCheckoutSession } from '../checkout/voice-checkout-session.types';

const SESSION_TTL_SEC = 3600;
const sessionKey = (callSessionId: string) => `voice:session:${callSessionId}`;

export type ShortTermSessionMemory = {
  history: ConversationTurn[];
  lastIntent?: VoiceIntent;
  pendingEmail?: string;
  pendingProductQuery?: string;
  lastSearchResults?: unknown[];
  checkout?: VoiceCheckoutSession;
  updatedAt: number;
};

@Injectable()
export class VoiceSessionMemoryService implements OnModuleDestroy {
  private readonly logger = new Logger(VoiceSessionMemoryService.name);
  private readonly fallback = new Map<string, ShortTermSessionMemory>();
  private redis: Redis | null = null;

  constructor(private readonly config: ConfigService) {
    const url = resolveRedisUrlFromConfig((k) => this.config.get<string>(k));
    if (url) {
      const { client } = createRedisClient(url, this.logger, 'VoiceSessionMemory');
      this.redis = client;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  async load(callSessionId: string): Promise<ShortTermSessionMemory> {
    const raw = await safeRedisGet(this.redis, sessionKey(callSessionId));
    if (raw) {
      try {
        return JSON.parse(raw) as ShortTermSessionMemory;
      } catch {
        /* fall through */
      }
    }
    return this.fallback.get(callSessionId) ?? { history: [], updatedAt: Date.now() };
  }

  async merge(
    callSessionId: string,
    patch: Partial<ShortTermSessionMemory>,
  ): Promise<ShortTermSessionMemory> {
    const current = await this.load(callSessionId);
    const next: ShortTermSessionMemory = {
      ...current,
      ...patch,
      history: patch.history ?? current.history,
      updatedAt: Date.now(),
    };
    const serialized = JSON.stringify(next);
    const ok = await safeRedisSetex(this.redis, sessionKey(callSessionId), SESSION_TTL_SEC, serialized);
    if (!ok) this.fallback.set(callSessionId, next);
    return next;
  }

  async appendTurn(
    callSessionId: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<void> {
    const mem = await this.load(callSessionId);
    const history = [...mem.history, { role, content }].slice(-24);
    await this.merge(callSessionId, { history });
  }
}
