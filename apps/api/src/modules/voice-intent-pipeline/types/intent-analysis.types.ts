export type IntentEmotion = 'angry' | 'frustrated' | 'neutral' | 'happy';

export type IntentUrgency = 'low' | 'medium' | 'high' | 'critical';

export type IntentRiskLevel = 'low' | 'medium' | 'high';

export type IntentAction =
  | 'order_lookup'
  | 'refund'
  | 'cancel'
  | 'shipping_check'
  | 'payment_link'
  | 'product_search'
  | 'escalate'
  | 'general';

export type IntentEntities = {
  order_id: string | null;
  order_ids: string[];
  products: string[];
  quantity: number | null;
  /** Full customer request — preserve all topics, never 1–2 line summary. */
  customer_request: string;
};

export type IntentAnalysisResult = {
  /** Primary topic label (same as legacy primary_intent). */
  intent: string;
  primary_intent: string;
  secondary_intents: string[];
  multi_intent: boolean;
  entities: IntentEntities;
  actions: IntentAction[];
  risk_level: IntentRiskLevel;
  emotion: IntentEmotion;
  urgency: IntentUrgency;
  refund_risk: boolean;
  source: 'openai' | 'rules_fallback' | 'cache';
  latencyMs?: number;
};

export type ActionExecutionRecord = {
  action: IntentAction;
  success: boolean;
  summary: string;
  detail?: string;
  orderId?: string;
};

import type { RoutingDecision } from './routing.types';

export type OrchestratedVoiceResponse = {
  text_response: string;
  voice_text: string;
  actions_executed: ActionExecutionRecord[];
  intent: IntentAnalysisResult;
  route?: RoutingDecision;
  escalation_id?: string;
  human_queue?: boolean;
};
