import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallDiagnosticsService } from '../services/voice-call-diagnostics.service';

test('records inbound, register-call, twiml, and status callback lifecycle', () => {
  const diag = new VoiceCallDiagnosticsService();
  const callSid = 'CA_test_diagnostics_001';

  diag.recordCallStarted({
    callSid,
    twilioCallStatus: 'ringing',
    callerPhoneMasked: '***4997',
    toPhoneMasked: '***4549',
    direction: 'inbound',
  });
  diag.recordRegisterCallResult({
    callSid,
    success: true,
    httpStatus: 200,
    twimlBytes: 226,
    latencyMs: 288,
  });
  diag.recordTwimlSent({
    callSid,
    twimlBytes: 226,
    personalizedGreeting: true,
    callerRecognized: true,
    totalElapsedMs: 910,
  });
  diag.recordTwilioStatusCallback({
    callSid,
    callStatus: 'completed',
    callDuration: '4',
    direction: 'inbound',
    from: '+923001234997',
    to: '+18456754549',
    sipResponseCode: '200',
    timestamp: new Date().toISOString(),
  });

  const snapshot = diag.getDiagnostics(callSid);
  assert.ok(snapshot);
  assert.equal(snapshot?.elevenlabs_register_call_success, true);
  assert.equal(snapshot?.elevenlabs_register_call_status, 200);
  assert.equal(snapshot?.twiml_sent, true);
  assert.equal(snapshot?.twiml_bytes, 226);
  assert.equal(snapshot?.twilio_final_status, 'completed');
  assert.equal(snapshot?.twilio_sip_response_code, '200');
  assert.equal(snapshot?.call_duration_seconds, 4);
  assert.equal(snapshot?.likely_failure_stage, 'likely_post_twiml_disconnect');
  assert.doesNotMatch(snapshot?.likely_reason ?? '', /\+923/);
  assert.ok(snapshot?.events.some((e) => e.event === 'call_status_callback_received'));
  assert.ok(snapshot?.events.some((e) => e.event === 'twiml_sent'));
});

test('records Twilio 31921 stream WebSocket close with stream error fields', () => {
  const diag = new VoiceCallDiagnosticsService();
  const callSid = 'CA_test_31921';

  diag.recordTwimlSent({ callSid, twimlBytes: 300 });
  diag.recordTwilioStatusCallback({
    callSid,
    callStatus: 'completed',
    callDuration: '2',
    errorCode: '31921',
    errorMessage: 'Stream - WebSocket - Close Error',
    streamError: 'connection_closed',
    sipResponseCode: '200',
  });

  const snapshot = diag.getDiagnostics(callSid);
  assert.equal(snapshot?.twilio_error_code, '31921');
  assert.equal(snapshot?.twilio_stream_error, 'connection_closed');
  assert.equal(snapshot?.likely_failure_stage, 'likely_post_twiml_disconnect');
  assert.match(snapshot?.likely_reason ?? '', /ElevenLabs closed the stream/i);
});

test('infers 31921 when call-status omits ErrorCode but Stream TwiML ended quickly', () => {
  const diag = new VoiceCallDiagnosticsService();
  const callSid = 'CA_test_inferred_31921';

  diag.recordTwimlSent({
    callSid,
    twimlBytes: 320,
    twimlHasStream: true,
    twimlHasConnect: true,
    conversationId: 'conv_test_inferred',
  });
  diag.recordTwilioStatusCallback({
    callSid,
    callStatus: 'completed',
    callDuration: '8',
  });

  const snapshot = diag.getDiagnostics(callSid);
  assert.equal(snapshot?.twiml_has_stream, true);
  assert.equal(snapshot?.inferred_twilio_31921, true);
  assert.equal(snapshot?.likely_failure_stage, 'likely_post_twiml_disconnect');

  const recent = diag.getMostRecentBridgeSnapshot();
  assert.equal(recent?.postTwimlLikelyIssue, true);
  assert.equal(recent?.conversationId, 'conv_test_inferred');
});

test('get-order style json never includes full phone in events', () => {
  const diag = new VoiceCallDiagnosticsService();
  const callSid = 'CA_test_mask_phone';
  diag.recordTwilioStatusCallback({
    callSid,
    callStatus: 'failed',
    from: '+15551234997',
    to: '+18456754549',
    errorCode: '31005',
    errorMessage: 'Connection error',
  });
  const json = JSON.stringify(diag.getDiagnostics(callSid));
  assert.doesNotMatch(json, /1234997/);
  assert.match(json, /\*\*\*4997/);
});
