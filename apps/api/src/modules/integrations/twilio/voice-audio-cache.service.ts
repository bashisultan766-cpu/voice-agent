import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type Redis from 'ioredis';
import {
  createRedisClient,
  resolveRedisUrlFromConfig,
  safeRedisGetBuffer,
  safeRedisSetex,
  type RedisLifecycleState,
} from '../../../common/redis-client.util';

const DEFAULT_REDIS_TTL_SEC = 7 * 24 * 60 * 60;

type CacheLayer = 'memory' | 'redis' | 'disk' | 'miss';

/**
 * Multi-tier voice audio cache: in-process (via VoicePromptAudioService), Redis, local disk.
 * Redis failures never crash voice runtime — falls back to memory → disk → ElevenLabs.
 */
@Injectable()
export class VoiceAudioCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoiceAudioCacheService.name);
  private redis: Redis | null = null;
  private redisState: RedisLifecycleState = { connected: false, ready: false };
  private readonly diskDir: string | null;
  private readonly redisTtlSec: number;
  private readonly cacheEnabled: boolean;

  lastHitLayer: CacheLayer = 'miss';

  constructor(private readonly config: ConfigService) {
    const dir = this.config.get<string>('VOICE_AUDIO_CACHE_DIR')?.trim();
    this.diskDir = dir || null;
    const ttlRaw = Number(this.config.get<string>('VOICE_AUDIO_CACHE_REDIS_TTL_SEC'));
    this.redisTtlSec =
      Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.trunc(ttlRaw) : DEFAULT_REDIS_TTL_SEC;
    this.cacheEnabled = this.resolveCacheEnabled();
  }

  isEnabled(): boolean {
    return this.cacheEnabled;
  }

  isRedisReady(): boolean {
    return this.redisState.ready;
  }

  private resolveCacheEnabled(): boolean {
    const raw = (
      this.config.get<string>('VOICE_AUDIO_CACHE_ENABLED') ??
      process.env.VOICE_AUDIO_CACHE_ENABLED ??
      'true'
    )
      .trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'no';
  }

  onModuleInit(): void {
    if (!this.cacheEnabled) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.audio_cache_disabled',
          reason: 'VOICE_AUDIO_CACHE_ENABLED=false',
        }),
      );
      return;
    }

    const url = resolveRedisUrlFromConfig((key) => this.config.get<string>(key));
    if (!url) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.audio_cache_redis_skipped',
          reason: 'REDIS_URL unset — memory + disk only',
        }),
      );
    } else {
      try {
        const { client, state } = createRedisClient(url, this.logger, 'VoiceAudioCacheService');
        this.redis = client;
        this.redisState = state;
      } catch (err) {
        this.logger.warn(
          JSON.stringify({
            event: 'redis.error',
            service: 'VoiceAudioCacheService',
            phase: 'init',
            message: err instanceof Error ? err.message : 'unknown',
            note: 'Continuing with memory + disk cache only',
          }),
        );
        this.redis = null;
      }
    }

    if (this.diskDir) {
      void mkdir(this.diskDir, { recursive: true }).catch(() => undefined);
      this.logger.log(
        JSON.stringify({
          event: 'voice.audio_cache_disk_ready',
          dir: this.diskDir,
        }),
      );
    }
  }

  onModuleDestroy(): void {
    void this.redis?.quit().catch(() => undefined);
  }

  audioHash(voiceId: string, modelId: string, text: string): string {
    const t = text.trim().slice(0, 2000);
    return createHash('sha256').update(`${voiceId}\0${modelId}\0${t}`, 'utf8').digest('hex');
  }

  /** Read cached mp3: Redis → disk. Never throws. */
  async getBuffer(audioHash: string): Promise<Buffer | null> {
    if (!this.cacheEnabled) return null;

    const fromRedis = await this.getFromRedis(audioHash);
    if (fromRedis) {
      this.lastHitLayer = 'redis';
      return fromRedis;
    }

    const fromDisk = await this.getFromDisk(audioHash);
    if (fromDisk) {
      this.lastHitLayer = 'disk';
      return fromDisk;
    }

    this.lastHitLayer = 'miss';
    return null;
  }

  async setBuffer(audioHash: string, buffer: Buffer): Promise<void> {
    if (!this.cacheEnabled) return;
    await Promise.allSettled([this.setRedis(audioHash, buffer), this.setDisk(audioHash, buffer)]);
  }

  logCacheEvent(
    hit: boolean,
    audioHash: string,
    layer: CacheLayer,
    callSessionId?: string,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: hit ? 'voice.audio_cache_hit' : 'voice.audio_cache_miss',
        audioCacheHit: hit,
        audioCacheMiss: !hit,
        audioHash: audioHash.slice(0, 16),
        layer,
        redisReady: this.redisState.ready,
        callSessionId: callSessionId ?? null,
      }),
    );
  }

  logCacheWarm(audioHash: string, elevenlabsLatencyMs: number, modelId: string, phrasePreview: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'voice.audio_cache_warm',
        audioCacheWarm: true,
        audioHash: audioHash.slice(0, 16),
        elevenlabsLatencyMs,
        elevenlabsModel: modelId,
        phrasePreview: phrasePreview.slice(0, 60),
      }),
    );
  }

  logWarmComplete(args: { agents: number; phrases: number; modelId: string }): void {
    this.logger.log(
      JSON.stringify({
        event: 'voice.audio_cache_warm_complete',
        agentsWarmed: args.agents,
        phrasesPerAgent: args.phrases,
        elevenlabsModel: args.modelId,
        cacheEnabled: this.cacheEnabled,
        diskDir: this.diskDir,
        redisConfigured: Boolean(this.redis),
        redisReady: this.redisState.ready,
      }),
    );
  }

  private redisKey(hash: string): string {
    return `voice:audio:${hash}`;
  }

  private diskPath(hash: string): string | null {
    if (!this.diskDir) return null;
    return join(this.diskDir, `${hash}.mp3`);
  }

  private async getFromRedis(hash: string): Promise<Buffer | null> {
    return safeRedisGetBuffer(this.redis, this.redisKey(hash));
  }

  private async setRedis(hash: string, buffer: Buffer): Promise<void> {
    const ok = await safeRedisSetex(this.redis, this.redisKey(hash), this.redisTtlSec, buffer);
    if (!ok) {
      this.logger.debug(
        JSON.stringify({
          event: 'voice.audio_cache_redis_write_skipped',
          audioHash: hash.slice(0, 16),
        }),
      );
    }
  }

  private async getFromDisk(hash: string): Promise<Buffer | null> {
    const path = this.diskPath(hash);
    if (!path) return null;
    try {
      const stat = await readFile(path);
      return stat.length > 0 ? stat : null;
    } catch {
      return null;
    }
  }

  private async setDisk(hash: string, buffer: Buffer): Promise<void> {
    const path = this.diskPath(hash);
    if (!path) return;
    try {
      await writeFile(path, buffer);
    } catch (err) {
      this.logger.debug(
        JSON.stringify({
          event: 'voice.audio_cache_disk_write_skipped',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }
  }
}
