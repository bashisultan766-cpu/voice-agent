import type { IntentEmotion, IntentUrgency } from './intent-analysis.types';

export type EscalationQueueStatus = 'pending' | 'assigned' | 'resolved';

/** Redis + Postgres escalation queue entry. */
export type EscalationQueueEntry = {
  id: string;
  callSessionId: string;
  tenantId: string;
  agentId: string;
  customer_id: string;
  reason: string;
  transcript: string;
  urgency: IntentUrgency;
  emotion: IntentEmotion;
  callback_required: boolean;
  status: EscalationQueueStatus;
  createdAtMs: number;
  slack_notified: boolean;
  email_notified: boolean;
};

export const ESCALATION_QUEUE_REDIS_PREFIX = 'voice:escalation-queue:';
export const ESCALATION_QUEUE_TTL_SEC = 7 * 24 * 60 * 60;
