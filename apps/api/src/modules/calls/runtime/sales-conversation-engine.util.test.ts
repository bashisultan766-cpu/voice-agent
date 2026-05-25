import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesTurnPlan } from './sales-conversation-engine.util';

test('buildSalesTurnPlan emits discovery for new callers', () => {
  const plan = buildSalesTurnPlan({
    userText: 'Hi I need a book',
    stage: 'DISCOVERY',
    userIntent: 'greeting',
    orderState: 'IDLE',
    objectionType: null,
    memory: {},
    hasProductDiscussed: false,
  });
  assert.match(plan.salesGuidance, /Sales conversation mode/);
  assert.ok(plan.discoveryQuestion);
});

test('buildSalesTurnPlan detects budget sensitivity', () => {
  const plan = buildSalesTurnPlan({
    userText: 'Something cheaper please',
    stage: 'OBJECTION_HANDLING',
    userIntent: 'product_question',
    orderState: 'PRODUCT_DISCOVERY',
    objectionType: 'need_cheaper',
    memory: {},
    hasProductDiscussed: true,
  });
  assert.equal(plan.memoryPatch.priceSensitivity, 'high');
});
