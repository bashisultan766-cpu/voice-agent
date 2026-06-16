import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repairTwimlIfMalformed,
  sanitizeTwiMLForLogging,
  twimlStructureFlags,
} from './twiml-sanitize.util';

test('twimlStructureFlags detects Connect and Conversation', () => {
  const twiml = '<Response><Connect><Conversation url="wss://x"/></Connect></Response>';
  const flags = twimlStructureFlags(twiml);
  assert.equal(flags.hasConnect, true);
  assert.equal(flags.hasConversation, true);
  assert.equal(flags.hasResponse, true);
});

test('sanitizeTwiMLForLogging masks URL tokens', () => {
  const twiml =
    '<Response><Connect><Conversation url="wss://api.elevenlabs.io/v1/convai?token=secret123&agent_id=agent_abc"/></Connect></Response>';
  const sanitized = sanitizeTwiMLForLogging(twiml);
  assert.match(sanitized, /token=\*\*\*/);
  assert.doesNotMatch(sanitized, /secret123/);
});

test('repairTwimlIfMalformed leaves valid TwiML unchanged', () => {
  const twiml = '<?xml version="1.0"?><Response><Connect><Conversation url="wss://x"/></Connect></Response>';
  const result = repairTwimlIfMalformed(twiml);
  assert.equal(result.repaired, false);
  assert.equal(result.twiml, twiml);
});

test('repairTwimlIfMalformed decodes HTML entities', () => {
  const broken = '&lt;Response&gt;&lt;Connect/&gt;&lt;/Response&gt;';
  const result = repairTwimlIfMalformed(broken);
  assert.equal(result.repaired, true);
  assert.equal(result.reason, 'html_entities');
  assert.match(result.twiml, /<Response>/);
});
