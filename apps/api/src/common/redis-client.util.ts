import { Logger } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';

/** Shared ioredis options — lazy connect, IPv4-only, resilient reconnect. */
export const REDIS_CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  family: 4,
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  retryStrategy(times: number): number {
    return Math.min(times * 100, 3000);
  },
  reconnectOnError(): boolean {
    return true;
  },
};

/** Force IPv4 loopback — never use localhost or ::1 (avoids ECONNREFUSED on dual-stack VPS). */
export function normalizeRedisUrl(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '[::1]') {
      url.hostname = '127.0.0.1';
    }
    return url.toString();
  } catch {
    return trimmed
      .replace(/\/\/localhost(?=[:/]|$)/gi, '//127.0.0.1')
      .replace(/\/\/\[::1\](?=[:/]|$)/gi, '//127.0.0.1')
      .replace(/\/\/::1(?=[:/]|$)/gi, '//127.0.0.1');
  }
}

/** Redact credentials for logs. */
export function sanitizeRedisUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username && u.username !== 'default') u.username = '***';
    return u.toString();
  } catch {
    return url.replace(/:([^:@/]+)@/, ':***@');
  }
}

export type RedisLifecycleState = {
  connected: boolean;
  ready: boolean;
};

/** Attach structured lifecycle logs; never throws or crashes on Redis errors. */
export function attachRedisLifecycleLogging(
  client: Redis,
  logger: Logger,
  serviceName: string,
  sanitizedUrl: string,
  state: RedisLifecycleState = { connected: false, ready: false },
): void {
  let lastErrorLogMs = 0;

  client.on('connect', () => {
    state.connected = true;
    logger.log(
      JSON.stringify({
        event: 'redis.connected',
        service: serviceName,
        redisUrl: sanitizedUrl,
      }),
    );
  });

  client.on('ready', () => {
    state.ready = true;
    logger.log(
      JSON.stringify({
        event: 'redis.connection.ready',
        service: serviceName,
        redisConnected: true,
        redisUrl: sanitizedUrl,
      }),
    );
  });

  client.on('reconnecting', (delayMs: number) => {
    state.ready = false;
    logger.warn(
      JSON.stringify({
        event: 'redis.reconnecting',
        service: serviceName,
        delayMs,
        redisUrl: sanitizedUrl,
      }),
    );
  });

  client.on('end', () => {
    state.connected = false;
    state.ready = false;
    logger.warn(
      JSON.stringify({
        event: 'redis.disconnected',
        service: serviceName,
        redisUrl: sanitizedUrl,
      }),
    );
  });

  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastErrorLogMs < 15_000) return;
    lastErrorLogMs = now;
    logger.warn(
      JSON.stringify({
        event: 'redis.error',
        service: serviceName,
        message: err.message,
        redisUrl: sanitizedUrl,
      }),
    );
  });
}

/**
 * Create a resilient Redis client for voice/search cache.
 * Connection is lazy and non-blocking; failures fall back to memory/disk.
 */
export function createRedisClient(
  rawUrl: string,
  logger: Logger,
  serviceName: string,
): { client: Redis; sanitizedUrl: string; state: RedisLifecycleState } {
  const normalized = normalizeRedisUrl(rawUrl);
  if (!normalized) {
    throw new Error(`${serviceName}: invalid REDIS_URL`);
  }
  const sanitizedUrl = sanitizeRedisUrlForLog(normalized);
  const state: RedisLifecycleState = { connected: false, ready: false };
  const client = new Redis(normalized, REDIS_CLIENT_OPTIONS);
  attachRedisLifecycleLogging(client, logger, serviceName, sanitizedUrl, state);

  void client.connect().catch((err: Error) => {
    logger.warn(
      JSON.stringify({
        event: 'redis.error',
        service: serviceName,
        phase: 'initial_connect',
        message: err.message,
        redisUrl: sanitizedUrl,
        note: 'Continuing with memory/disk cache fallback',
      }),
    );
  });

  return { client, sanitizedUrl, state };
}

/** Resolve REDIS_URL from ConfigService or process.env with IPv4 normalization. */
export function resolveRedisUrlFromConfig(
  get: (key: string) => string | undefined,
): string | null {
  return normalizeRedisUrl(get('REDIS_URL') ?? process.env.REDIS_URL);
}

/** Safe Redis read — never throws; returns null on any failure or when not ready. */
export async function safeRedisGetBuffer(client: Redis | null, key: string): Promise<Buffer | null> {
  if (!client) return null;
  if (client.status !== 'ready') return null;
  try {
    const raw = await client.getBuffer(key);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Safe Redis write — never throws. */
export async function safeRedisSetex(
  client: Redis | null,
  key: string,
  ttlSec: number,
  value: Buffer | string,
): Promise<boolean> {
  if (!client) return false;
  try {
    if (client.status !== 'ready') return false;
    await client.setex(key, ttlSec, value);
    return true;
  } catch {
    return false;
  }
}

/** Safe Redis string read — never throws. */
export async function safeRedisGet(client: Redis | null, key: string): Promise<string | null> {
  if (!client) return null;
  if (client.status !== 'ready') return null;
  try {
    const raw = await client.get(key);
    return raw ?? null;
  } catch {
    return null;
  }
}
