import type { IntentAnalysisResult } from './intent-analysis.types';

export type RoutingRoute =
  | 'human_queue'
  | 'refund_priority'
  | 'automation_batch'
  | 'standard_automation';

export type RoutingDecision = {
  route: RoutingRoute;
  escalate: boolean;
  skip_llm: boolean;
  batch_shopify: boolean;
  callback_required: boolean;
  reason: string;
};

export type OrchestratorContext = {
  intent: IntentAnalysisResult;
  callSessionId: string;
  tenantId: string;
  agentId: string;
};
