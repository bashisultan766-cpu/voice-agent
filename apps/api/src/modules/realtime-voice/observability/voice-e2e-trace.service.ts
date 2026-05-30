import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  createRedisClient,
  resolveRedisUrlFromConfig,
  safeRedisGet,
  safeRedisSetex,
} from '../../../common/redis-client.util';
import type Redis from 'ioredis';
import type { VoiceE2EStep, VoiceE2EStepRecord, VoiceE2ETraceSnapshot } from './voice-e2e-trace.types';

const TRACE_TTL_SEC = 24 * 60 * 60;
const traceKey = (traceId: string) => `voice:e2e:trace:${traceId}`;
const sessionTraceKey = (callSessionId: string) => `voice:e2e:session:${callSessionId}`;

@Injectable()
export class VoiceE2ETraceService implements OnModuleDestroy {
  private readonly logger = new Logger(VoiceE2ETraceService.name);
  private redis: Redis | null = null;
  private readonly memory = new Map<string, VoiceE2ETraceSnapshot>();
  private readonly sessionToTrace = new Map<string, string>();

  constructor(private readonly config: ConfigService) {
    const url = resolveRedisUrlFromConfig((k) => this.config.get<string>(k));
    if (url) {
      try {
        const { client } = createRedisClient(url, this.logger, 'VoiceE2ETraceService');
        this.redis = client;
      } catch {
        this.redis = null;
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  startTrace(callSessionId: string, mode: 'synthetic' | 'live' = 'synthetic'): string {
    const traceId = `vtrace_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const snapshot: VoiceE2ETraceSnapshot = {
      traceId,
      callSessionId,
      startedAt: Date.now(),
      mode,
      steps: [],
    };
    this.memory.set(traceId, snapshot);
    this.sessionToTrace.set(callSessionId, traceId);
    void this.persist(snapshot);
    void this.persistSessionMap(callSessionId, traceId);

    this.logger.log(
      JSON.stringify({
        event: 'voice.e2e.trace_started',
        dashboard: 'latency',
        traceId,
        callSessionId,
        mode,
      }),
    );
    return traceId;
  }

  resolveTraceId(callSessionId: string): string | undefined {
    return this.sessionToTrace.get(callSessionId);
  }

  async record(
    callSessionId: string,
    step: VoiceE2EStep,
    meta: {
      latencyMs?: number;
      ok?: boolean;
      provider?: string;
      error?: string;
      traceId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const traceId = meta.traceId ?? this.sessionToTrace.get(callSessionId);
    if (!traceId) return;

    const record: VoiceE2EStepRecord = {
      step,
      timestamp: Date.now(),
      latencyMs: meta.latencyMs,
      ok: meta.ok,
      provider: meta.provider,
      error: meta.error,
      metadata: meta.metadata,
    };

    const snapshot = this.memory.get(traceId) ?? (await this.load(traceId));
    if (!snapshot) return;

    snapshot.steps.push(record);
    this.memory.set(traceId, snapshot);
    void this.persist(snapshot);

    const dashboard = meta.ok === false || meta.error ? 'error' : 'latency';
    this.logger.log(
      JSON.stringify({
        event: `voice.e2e.${step}`,
        dashboard,
        traceId,
        callSessionId,
        step,
        latencyMs: meta.latencyMs ?? null,
        ok: meta.ok ?? true,
        provider: meta.provider ?? null,
        error: meta.error ?? null,
        ...(meta.metadata ?? {}),
      }),
    );
  }

  async finishTrace(traceId: string): Promise<VoiceE2ETraceSnapshot | null> {
    const snapshot = this.memory.get(traceId) ?? (await this.load(traceId));
    if (!snapshot) return null;
    snapshot.endedAt = Date.now();
    this.memory.set(traceId, snapshot);
    await this.persist(snapshot);
    this.logger.log(
      JSON.stringify({
        event: 'voice.e2e.trace_finished',
        dashboard: 'latency',
        traceId,
        callSessionId: snapshot.callSessionId,
        durationMs: snapshot.endedAt - snapshot.startedAt,
        stepCount: snapshot.steps.length,
      }),
    );
    return snapshot;
  }

  async getTrace(traceId: string): Promise<VoiceE2ETraceSnapshot | null> {
    return this.memory.get(traceId) ?? (await this.load(traceId));
  }

  private async persist(snapshot: VoiceE2ETraceSnapshot): Promise<void> {
    const payload = JSON.stringify(snapshot);
    await safeRedisSetex(this.redis, traceKey(snapshot.traceId), TRACE_TTL_SEC, payload);
  }

  private async persistSessionMap(callSessionId: string, traceId: string): Promise<void> {
    await safeRedisSetex(this.redis, sessionTraceKey(callSessionId), TRACE_TTL_SEC, traceId);
  }

  private async load(traceId: string): Promise<VoiceE2ETraceSnapshot | null> {
    const raw = await safeRedisGet(this.redis, traceKey(traceId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as VoiceE2ETraceSnapshot;
      this.memory.set(traceId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }
}
