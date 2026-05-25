import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPolicyTopic, isStorePolicyQuestion } from './policy-intent.util';
import { classifyUserIntent } from './user-intent-classifier.util';

test('classifyPolicyTopic detects refund and hours', () => {
  assert.equal(classifyPolicyTopic('What is your return policy?'), 'refund');
  assert.equal(classifyPolicyTopic('What are your store hours on Saturday?'), 'store_hours');
});

test('store hours utterance is store_policy_question not product_search', () => {
  assert.equal(classifyUserIntent('What are your store hours on Saturday?'), 'store_policy_question');
});

test('isStorePolicyQuestion true for shipping', () => {
  assert.equal(isStorePolicyQuestion('How long does shipping take?'), true);
});
