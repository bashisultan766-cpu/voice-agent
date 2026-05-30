import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import Redis from 'ioredis';

const DEFAULT_REDIS_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * Multi-tier voice audio cache: in-process (via VoicePromptAudioService), Redis, local disk.
 * Hot path reads memory first; warm path persists across restarts via Redis/disk.
 */
@Injectable()
export class VoiceAudioCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoiceAudioCacheService.name);
  private redis: Redis | null = null;
  private readonly diskDir: string | null;
  private readonly redisTtlSec: number;

  constructor(private readonly config: ConfigService) {
    const dir = this.config.get<string>('VOICE_AUDIO_CACHE_DIR')?.trim();
    this.diskDir = dir || null;
    const ttlRaw = Number(this.config.get<string>('VOICE_AUDIO_CACHE_REDIS_TTL_SEC'));
    this.redisTtlSec =
      Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.trunc(ttlRaw) : DEFAULT_REDIS_TTL_SEC;
  }

  onModuleInit(): void {
    const url = this.config.get<string>('REDIS_URL')?.trim();
    if (!url) return;
    try {
      this.redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
      this.redis.on('error', (err) => {
        this.logger.warn(`Voice audio Redis cache unavailable: ${err.message}`);
      });
    } catch (err) {
      this.logger.warn(
        `Voice audio Redis init failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
    if (this.diskDir) {
      void mkdir(this.diskDir, { recursive: true }).catch(() => undefined);
    }
  }

  onModuleDestroy(): void {
    void this.redis?.quit().catch(() => undefined);
  }

  audioHash(voiceId: string, modelId: string, text: string): string {
    const t = text.trim().slice(0, 2000);
    return createHash('sha256').update(`${voiceId}\0${modelId}\0${t}`, 'utf8').digest('hex');
  }

  /** Read cached mp3 from Redis or disk (not in-memory — caller owns L1). */
  async getBuffer(audioHash: string): Promise<Buffer | null> {
    const fromRedis = await this.getFromRedis(audioHash);
    if (fromRedis) return fromRedis;
    return this.getFromDisk(audioHash);
  }

  /** Persist mp3 to Redis + disk after ElevenLabs generation. */
  async setBuffer(audioHash: string, buffer: Buffer): Promise<void> {
    await Promise.allSettled([this.setRedis(audioHash, buffer), this.setDisk(audioHash, buffer)]);
  }

  logCacheEvent(
    hit: boolean,
    audioHash: string,
    layer: 'memory' | 'redis' | 'disk' | 'miss',
    callSessionId?: string,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: hit ? 'voice.audio_cache_hit' : 'voice.audio_cache_miss',
        audioCacheHit: hit,
        audioCacheMiss: !hit,
        audioHash: audioHash.slice(0, 16),
        layer,
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

  private redisKey(hash: string): string {
    return `voice:audio:${hash}`;
  }

  private diskPath(hash: string): string | null {
    if (!this.diskDir) return null;
    return join(this.diskDir, `${hash}.mp3`);
  }

  private async getFromRedis(hash: string): Promise<Buffer | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.getBuffer(this.redisKey(hash));
      return raw && raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  }

  private async setRedis(hash: string, buffer: Buffer): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.setex(this.redisKey(hash), this.redisTtlSec, buffer);
    } catch (err) {
      this.logger.debug(
        `Voice audio Redis write skipped: ${err instanceof Error ? err.message : 'unknown'}`,
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
        `Voice audio disk write skipped: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
}
