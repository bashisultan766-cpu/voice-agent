import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AIOrchestratorService } from './ai-orchestrator.service';
import type { IntentAnalysisResult } from './types/intent-analysis.types';

const baseIntent = (): IntentAnalysisResult => ({
  intent: 'order_status',
  primary_intent: 'order_status',
  secondary_intents: [],
  multi_intent: false,
  entities: {
    order_id: '1042',
    order_ids: ['1042'],
    products: [],
    quantity: null,
    customer_request: 'Where is my order?',
  },
  actions: ['order_lookup', 'shipping_check'],
  risk_level: 'low',
  emotion: 'neutral',
  urgency: 'low',
  refund_risk: false,
  source: 'openai',
});

describe('AIOrchestratorService', () => {
  const orchestrator = new AIOrchestratorService();

  it('routes angry customers to human queue', () => {
    const decision = orchestrator.decide({ ...baseIntent(), emotion: 'angry', urgency: 'high' });
    assert.equal(decision.route, 'human_queue');
    assert.equal(decision.escalate, true);
    assert.equal(decision.skip_llm, true);
  });

  it('prioritizes refund workflow when refund_risk', () => {
    const decision = orchestrator.decide({ ...baseIntent(), refund_risk: true, actions: ['refund', 'order_lookup'] });
    assert.equal(decision.route, 'refund_priority');
    const ordered = orchestrator.prioritizeActions(
      { ...baseIntent(), refund_risk: true, actions: ['order_lookup', 'refund'] },
      decision,
    );
    assert.equal(ordered[0], 'refund');
  });

  it('batches multi-intent Shopify operations', () => {
    const decision = orchestrator.decide({
      ...baseIntent(),
      multi_intent: true,
      actions: ['order_lookup', 'shipping_check', 'refund'],
    });
    assert.equal(decision.route, 'automation_batch');
    assert.equal(decision.batch_shopify, true);
  });
});
