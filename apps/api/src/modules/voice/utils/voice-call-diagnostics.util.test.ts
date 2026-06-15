import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferLikelyFailureStage,
  maskPhoneForCallDiagnostics,
  buildLikelyDisconnectReason,
} from './voice-call-diagnostics.util';

test('maskPhoneForCallDiagnostics masks all but last 4 digits', () => {
  assert.equal(maskPhoneForCallDiagnostics('+15551234997'), '***4997');
  assert.equal(maskPhoneForCallDiagnostics(''), null);
});

test('inferLikelyFailureStage detects quick post-twiml disconnect', () => {
  const stage = inferLikelyFailureStage({
    twimlSentAt: Date.now() - 5000,
    registerCallSuccess: true,
    twilioFinalStatus: 'completed',
    callDurationSeconds: 3,
    twilioErrorCode: null,
  });
  assert.equal(stage, 'likely_post_twiml_disconnect');
});

test('buildLikelyDisconnectReason explains missing status callback', () => {
  const reason = buildLikelyDisconnectReason('awaiting_twilio_status', {
    twilioErrorCode: null,
    twilioErrorMessage: null,
    callDurationSeconds: null,
    registerCallSuccess: true,
  });
  assert.match(reason, /status callback/i);
});
