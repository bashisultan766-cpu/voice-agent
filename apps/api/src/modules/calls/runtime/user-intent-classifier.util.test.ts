import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUserIntent } from './user-intent-classifier.util';

test('classifies payment question', () => {
  assert.equal(classifyUserIntent('How does payment work?'), 'payment_question');
});

test('classifies store identity question', () => {
  assert.equal(classifyUserIntent('What store is this?'), 'store_identity_question');
});

test('classifies store category question', () => {
  assert.equal(classifyUserIntent('Can I get sports products here?'), 'store_category_question');
});

test('classifies capability question', () => {
  assert.equal(classifyUserIntent('How can you help me?'), 'capability_question');
});

test('classifies general business question', () => {
  assert.equal(classifyUserIntent('How does this work?'), 'general_business_question');
});

test('classifies email provided', () => {
  assert.equal(classifyUserIntent('my email is user@example.com'), 'email_provided');
});

test('classifies correction', () => {
  assert.equal(classifyUserIntent('No, I mean the paperback edition'), 'correction');
});

test('classifies purchase confirmation', () => {
  assert.equal(classifyUserIntent('Yes, I want to buy it'), 'purchase_confirmation');
});

test('classifies vague short turns as unclear', () => {
  assert.equal(classifyUserIntent('uh maybe'), 'unclear');
});

