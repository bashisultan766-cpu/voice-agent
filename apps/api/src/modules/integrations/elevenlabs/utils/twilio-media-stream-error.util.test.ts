import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPostTwimlStreamIssue,
  isTwilioStreamWebSocketCloseError,
  TWILIO_STREAM_WEBSOCKET_CLOSE_ERROR,
} from './twilio-media-stream-error.util';

test('detects Twilio 31921 stream WebSocket close error', () => {
  assert.equal(isTwilioStreamWebSocketCloseError(TWILIO_STREAM_WEBSOCKET_CLOSE_ERROR), true);
  assert.equal(isTwilioStreamWebSocketCloseError('31005'), false);
  assert.equal(isTwilioStreamWebSocketCloseError(null), false);
});

test('postTwimlStreamIssue requires Stream TwiML and error 31921', () => {
  assert.equal(
    isPostTwimlStreamIssue({ twimlHasStream: true, errorCode: '31921' }),
    true,
  );
  assert.equal(
    isPostTwimlStreamIssue({ twimlHasStream: false, errorCode: '31921' }),
    false,
  );
  assert.equal(
    isPostTwimlStreamIssue({ twimlHasStream: true, errorCode: '31005' }),
    false,
  );
});

test('postTwimlStreamIssue infers from short completed Stream call without ErrorCode', () => {
  assert.equal(
    isPostTwimlStreamIssue({
      twimlHasStream: true,
      errorCode: null,
      callDurationSeconds: 8,
      callStatus: 'completed',
    }),
    true,
  );
  assert.equal(
    isPostTwimlStreamIssue({
      twimlHasStream: true,
      errorCode: null,
      callDurationSeconds: 45,
      callStatus: 'completed',
    }),
    false,
  );
});
