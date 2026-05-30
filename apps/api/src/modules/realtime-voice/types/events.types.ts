import type { VoiceIntent, AgentTaskResult } from './voice-turn.types';

export type VoiceEventType =
  | 'turn.received'
  | 'intent.routed'
  | 'filler.spoken'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'
  | 'reply.synthesized'
  | 'memory.updated'
  | 'analytics.recorded'
  | 'stream.chunk'
  | 'stream.interrupted';

export type VoiceEventPayload = {
  callSessionId: string;
  tenantId?: string;
  agentId?: string;
  intent?: VoiceIntent;
  agent?: string;
  result?: AgentTaskResult;
  text?: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
};

export type VoiceEvent = {
  type: VoiceEventType;
  timestamp: number;
  payload: VoiceEventPayload;
};
