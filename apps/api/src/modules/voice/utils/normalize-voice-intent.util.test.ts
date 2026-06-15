import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySureShotVoiceIntent,
  containsOrderSignal,
  normalizeTranscriptText,
} from './normalize-voice-intent.util';

test('I give you the order => collect_order_number', () => {
  const result = classifySureShotVoiceIntent('I give you the order');
  assert.equal(result.intent, 'collect_order_number');
  assert.equal(result.suggestedAction, 'collect_order_number');
  assert.equal(result.isOrderRelated, true);
});

test('order number => collect_order_number', () => {
  const result = classifySureShotVoiceIntent('what is my order number');
  assert.equal(result.intent, 'collect_order_number');
  assert.match(result.transcriptNormalized, /order/);
});

test('track my order => tracking_status', () => {
  const result = classifySureShotVoiceIntent('can you track my order please');
  assert.equal(result.intent, 'tracking_status');
  assert.equal(result.suggestedAction, 'get_order_tracking');
});

test('refund on my card => refund_status', () => {
  const result = classifySureShotVoiceIntent('I need a refund on my card');
  assert.equal(result.intent, 'refund_status');
  assert.equal(result.suggestedAction, 'get_order_refund');
});

test('send me facility payment link => facility_payment_link', () => {
  const result = classifySureShotVoiceIntent('send me facility payment link');
  assert.equal(result.intent, 'facility_payment_link');
  assert.equal(result.suggestedAction, 'create_facility_secure_link');
});

test('what address is on this order => address_on_order', () => {
  const result = classifySureShotVoiceIntent('what address is on this order');
  assert.equal(result.intent, 'address_on_order');
  assert.equal(result.suggestedAction, 'get_order_with_verification');
});

test("what is another customer's address => address_other_customer", () => {
  const result = classifySureShotVoiceIntent("what is another customer's address");
  assert.equal(result.intent, 'address_other_customer');
  assert.equal(result.suggestedAction, 'refuse_third_party_address');
});

test('fuzzy ordinary => order blocks medical refusal', () => {
  const normalized = normalizeTranscriptText('I need help with my ordinary status');
  assert.match(normalized, /\border\b/);
  assert.equal(containsOrderSignal(normalized), true);

  const result = classifySureShotVoiceIntent('symptom treatment for my ordinary');
  assert.notEqual(result.intent, 'medical_refusal');
  assert.equal(result.blocksMedicalRefusal, true);
});

test('medical topic without order signal => medical_refusal', () => {
  const result = classifySureShotVoiceIntent('what medication dosage should I take');
  assert.equal(result.intent, 'medical_refusal');
  assert.equal(result.blocksMedicalRefusal, false);
});

test('where is my order fuzzy phrase => tracking_status', () => {
  const result = classifySureShotVoiceIntent('where is my order');
  assert.equal(result.intent, 'tracking_status');
});

test('card refund phrase => refund_status', () => {
  const result = classifySureShotVoiceIntent('card refund please');
  assert.equal(result.intent, 'refund_status');
});

test('ordering mishearing normalizes to order keyword', () => {
  const normalized = normalizeTranscriptText('I was ordering books last week');
  assert.match(normalized, /\border\b/);
  assert.doesNotMatch(normalized, /ordering/);
});
