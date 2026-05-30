import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTwiML } from './elevenlabs-twilio-register-call.service';

test('extractTwiML accepts raw XML', () => {
  const xml = '<?xml version="1.0"?><Response><Say>hi</Say></Response>';
  assert.equal(extractTwiML(xml), xml);
});

test('extractTwiML accepts JSON wrapper', () => {
  const xml = '<Response><Connect/></Response>';
  const raw = JSON.stringify({ twiml: xml });
  assert.equal(extractTwiML(raw), xml);
});
