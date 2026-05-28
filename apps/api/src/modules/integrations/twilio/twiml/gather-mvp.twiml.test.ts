import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInboundGatherMvpTwiML } from './gather-mvp.twiml';

test('gather TwiML defaults to conversational capture settings', () => {
  const xml = buildInboundGatherMvpTwiML({
    gatherActionUrl: 'https://agent.mailcallcommunication.com/api/twilio/voice/gather?callSessionId=abc',
    language: 'en-US',
  });
  assert.match(xml, /speechTimeout="auto"/);
  assert.match(xml, /timeout="5"/);
  assert.match(xml, /actionOnEmptyResult="true"/);
});

test('gather TwiML omits nested prompt media for barge-in mode', () => {
  const xml = buildInboundGatherMvpTwiML({
    gatherActionUrl: 'https://agent.mailcallcommunication.com/api/twilio/voice/gather?callSessionId=abc',
    language: 'en-US',
    playbackAudioUrl: 'https://agent.mailcallcommunication.com/api/twilio/voice/tts/token',
    openingSayText: 'Hello there',
    includePromptInsideGather: false,
  });
  assert.doesNotMatch(xml, /<Gather[\s\S]*<Play>/);
  assert.doesNotMatch(xml, /<Gather[\s\S]*<Say/);
});

