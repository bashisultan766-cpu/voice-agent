import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

interface CachedAudioEntry {
  data: Buffer;
  expiresAt: number;
}

@Injectable()
export class TwilioTtsCacheService {
  private readonly cache = new Map<string, CachedAudioEntry>();
  private readonly ttlMs = 5 * 60 * 1000;

  put(data: Buffer): string {
    this.pruneExpired();
    const token = randomBytes(24).toString('hex');
    this.cache.set(token, {
      data,
      expiresAt: Date.now() + this.ttlMs,
    });
    return token;
  }

  take(token: string): Buffer | null {
    const entry = this.cache.get(token);
    if (!entry) return null;
    this.cache.delete(token);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.data;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [token, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(token);
      }
    }
  }
}
