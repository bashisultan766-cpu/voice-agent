import type { VoiceSessionContext } from '../../calls/runtime/session-context.service';
import type { VoiceCheckoutSession } from '../checkout/voice-checkout-session.types';

/** Intent labels produced by the Router Agent. */
export type VoiceIntent =
  | 'greeting'
  | 'product_search'
  | 'isbn_search'
  | 'checkout'
  | 'email_capture'
  | 'order_status'
  | 'support'
  | 'casual'
  | 'unknown';

export type ConversationTurn = { role: 'user' | 'assistant'; content: string };

export type VoiceTurnInput = {
  callSessionId: string;
  utterance: string;
  history: ConversationTurn[];
  context: VoiceSessionContext;
};

export type AgentTaskResult = {
  agent: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  latencyMs: number;
};

export type VoiceTurnOutput = {
  reply: string;
  /** Spoken immediately while background agents run (deferred poll path). */
  immediateFiller?: string;
  intent: VoiceIntent;
  needsDeferredPoll?: boolean;
  agentResults: AgentTaskResult[];
  modelUsed: string;
  totalLatencyMs: number;
  turnProof: Record<string, unknown>;
};

export type VoiceGraphState = {
  callSessionId: string;
  utterance: string;
  history: ConversationTurn[];
  context: VoiceSessionContext;
  intent: VoiceIntent;
  intentConfidence: number;
  immediateFiller: string;
  agentResults: AgentTaskResult[];
  reply: string;
  modelUsed: string;
  escalateToComplexModel: boolean;
  memoryPatch: Record<string, unknown>;
  checkoutSession: VoiceCheckoutSession;
};
