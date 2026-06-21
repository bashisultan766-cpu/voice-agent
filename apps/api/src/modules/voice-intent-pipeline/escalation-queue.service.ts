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
import { CallbackRequestsService } from '../calls/callback-requests.service';
import { CallsService } from '../calls/calls.service';
import type { IntentAnalysisResult } from './types/intent-analysis.types';
import {
  ESCALATION_QUEUE_REDIS_PREFIX,
  ESCALATION_QUEUE_TTL_SEC,
  type EscalationQueueEntry,
} from './types/escalation-queue.types';

@Injectable()
export class EscalationQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(EscalationQueueService.name);
  private readonly fallback = new Map<string, EscalationQueueEntry>();
  private redis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly callbackRequests: CallbackRequestsService,
    private readonly callsService: CallsService,
  ) {
    const url = resolveRedisUrlFromConfig((k) => this.config.get<string>(k));
    if (url) {
      const { client } = createRedisClient(url, this.logger, 'EscalationQueue');
      this.redis = client;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  private entryKey(id: string): string {
    return `${ESCALATION_QUEUE_REDIS_PREFIX}entry:${id}`;
  }

  private tenantIndexKey(tenantId: string): string {
    return `${ESCALATION_QUEUE_REDIS_PREFIX}tenant:${tenantId}:pending`;
  }

  async enqueue(args: {
    callSessionId: string;
    tenantId: string;
    agentId: string;
    customerId: string;
    reason: string;
    transcript: string;
    intent: IntentAnalysisResult;
    callbackRequired: boolean;
    callerPhone?: string;
  }): Promise<EscalationQueueEntry> {
    const id = `esc_${randomUUID().slice(0, 12)}`;
    const entry: EscalationQueueEntry = {
      id,
      callSessionId: args.callSessionId,
      tenantId: args.tenantId,
      agentId: args.agentId,
      customer_id: args.customerId,
      reason: args.reason.slice(0, 2000),
      transcript: args.transcript.slice(0, 8000),
      urgency: args.intent.urgency,
      emotion: args.intent.emotion,
      callback_required: args.callbackRequired,
      status: 'pending',
      createdAtMs: Date.now(),
      slack_notified: false,
      email_notified: false,
    };

    await this.persistEntry(entry);
    await this.notifySlack(entry);
    await this.notifyEmail(entry);
    await this.persistCallbackRequest(entry, args.callerPhone);

    await this.callsService.mergeSessionMetadata(args.callSessionId, {
      escalationQueueId: id,
      humanEscalationRequired: true,
      escalationUrgency: entry.urgency,
      escalationEmotion: entry.emotion,
    });

    await this.callsService.updateSessionStatus(args.callSessionId, {
      escalated: true,
      lastEventAt: new Date(),
    });

    this.logger.log(
      JSON.stringify({
        event: 'voice.escalation.enqueued',
        id,
        callSessionId: args.callSessionId,
        urgency: entry.urgency,
        emotion: entry.emotion,
        callback_required: entry.callback_required,
      }),
    );

    return entry;
  }

  async getPendingForTenant(tenantId: string, limit = 50): Promise<EscalationQueueEntry[]> {
    const indexRaw = await safeRedisGet(this.redis, this.tenantIndexKey(tenantId));
    const ids: string[] = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];
    const entries: EscalationQueueEntry[] = [];
    for (const id of ids.slice(0, limit)) {
      const e = await this.getById(id);
      if (e && e.status === 'pending') entries.push(e);
    }
    if (entries.length === 0) {
      return [...this.fallback.values()]
        .filter((e) => e.tenantId === tenantId && e.status === 'pending')
        .slice(0, limit);
    }
    return entries;
  }

  async getById(id: string): Promise<EscalationQueueEntry | null> {
    const raw = await safeRedisGet(this.redis, this.entryKey(id));
    if (raw) {
      try {
        return JSON.parse(raw) as EscalationQueueEntry;
      } catch {
        return null;
      }
    }
    return this.fallback.get(id) ?? null;
  }

  private async persistEntry(entry: EscalationQueueEntry): Promise<void> {
    const serialized = JSON.stringify(entry);
    const ok = await safeRedisSetex(
      this.redis,
      this.entryKey(entry.id),
      ESCALATION_QUEUE_TTL_SEC,
      serialized,
    );
    if (!ok) this.fallback.set(entry.id, entry);

    const indexKey = this.tenantIndexKey(entry.tenantId);
    const prevRaw = await safeRedisGet(this.redis, indexKey);
    const prev: string[] = prevRaw ? (JSON.parse(prevRaw) as string[]) : [];
    const next = [entry.id, ...prev.filter((x) => x !== entry.id)].slice(0, 200);
    await safeRedisSetex(this.redis, indexKey, ESCALATION_QUEUE_TTL_SEC, JSON.stringify(next));
  }

  private async persistCallbackRequest(entry: EscalationQueueEntry, phone?: string): Promise<void> {
    const normalizedPhone = phone?.trim() || entry.customer_id;
    if (!normalizedPhone || normalizedPhone.startsWith('session:')) return;

    try {
      await this.callbackRequests.create({
        tenantId: entry.tenantId,
        agentId: entry.agentId,
        callSessionId: entry.callSessionId,
        phone: normalizedPhone,
        reason: entry.reason.slice(0, 500),
        priority: entry.urgency === 'critical' || entry.urgency === 'high' ? 'high' : 'normal',
        notes: `emotion=${entry.emotion}; escalation_id=${entry.id}`,
      });
      await this.callbackRequests.markRequestedOnSession(entry.callSessionId);
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.escalation.callback_persist_failed',
          id: entry.id,
          message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        }),
      );
    }
  }

  private async notifySlack(entry: EscalationQueueEntry): Promise<void> {
    const webhook = this.config.get<string>('ESCALATION_SLACK_WEBHOOK_URL')?.trim();
    if (!webhook) return;

    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `:rotating_light: *Voice escalation* (${entry.urgency}/${entry.emotion})\n*Reason:* ${entry.reason.slice(0, 300)}\n*Session:* ${entry.callSessionId}\n*Callback:* ${entry.callback_required ? 'yes' : 'no'}`,
        }),
      });
      entry.slack_notified = res.ok;
      await this.persistEntry(entry);
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.escalation.slack_failed',
          id: entry.id,
          message: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
        }),
      );
    }
  }

  private async notifyEmail(entry: EscalationQueueEntry): Promise<void> {
    const to =
      this.config.get<string>('ESCALATION_NOTIFY_EMAIL')?.trim() ||
      this.config.get<string>('CUSTOMER_SERVICE_EMAIL')?.trim();
    const apiKey = this.config.get<string>('RESEND_API_KEY')?.trim();
    const from = this.config.get<string>('RESEND_FROM_EMAIL')?.trim();
    if (!to || !apiKey || !from) return;

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: `[Voice Escalation ${entry.urgency}] ${entry.reason.slice(0, 60)}`,
          text: `Escalation ID: ${entry.id}\nSession: ${entry.callSessionId}\nCustomer: ${entry.customer_id}\nEmotion: ${entry.emotion}\nUrgency: ${entry.urgency}\nCallback required: ${entry.callback_required}\n\nReason:\n${entry.reason}\n\nTranscript excerpt:\n${entry.transcript.slice(0, 1500)}`,
        }),
      });
      entry.email_notified = res.ok;
      await this.persistEntry(entry);
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.escalation.email_failed',
          id: entry.id,
          message: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
        }),
      );
    }
  }
}
