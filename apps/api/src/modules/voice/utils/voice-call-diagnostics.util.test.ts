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

test('buildLikelyDisconnectReason explains Twilio 31921 stream close', () => {
  const reason = buildLikelyDisconnectReason('likely_post_twiml_disconnect', {
    twilioErrorCode: '31921',
    twilioErrorMessage: 'Stream - WebSocket - Close Error',
    callDurationSeconds: 2,
    registerCallSuccess: true,
  });
  assert.match(reason, /ElevenLabs closed the stream/i);
  assert.match(reason, /31921/);
});

test('inferLikelyFailureStage maps 31921 to likely_post_twiml_disconnect', () => {
  const stage = inferLikelyFailureStage({
    twimlSentAt: Date.now() - 2000,
    registerCallSuccess: true,
    twilioFinalStatus: 'completed',
    callDurationSeconds: 2,
    twilioErrorCode: '31921',
  });
  assert.equal(stage, 'likely_post_twiml_disconnect');
});
