import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeferredVoiceKickoffTwiML,
  buildDeferredVoiceMomentPleaseTwiML,
  buildInboundGatherMvpTwiML,
} from './gather-mvp.twiml';

test('gather TwiML defaults to conversational capture settings', () => {
  const xml = buildInboundGatherMvpTwiML({
    gatherActionUrl: 'https://agent.mailcallcommunication.com/api/twilio/voice/gather?callSessionId=abc',
    language: 'en-US',
  });
  assert.match(xml, /speechTimeout="auto"/);
  assert.match(xml, /timeout="5"/);
  assert.match(xml, /actionOnEmptyResult="true"/);
});

test('gather TwiML does not inject default Twilio Say when no Play or Say text', () => {
  const xml = buildInboundGatherMvpTwiML({
    gatherActionUrl: 'https://agent.example.com/api/twilio/voice/gather?callSessionId=abc',
    language: 'en-US',
  });
  assert.doesNotMatch(xml, /<Say/);
  assert.match(xml, /<Gather/);
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

test('deferred kickoff with FORCE_ELEVENLABS_ONLY style has no Twilio Say', () => {
  const xml = buildDeferredVoiceKickoffTwiML({
    deferPollUrl: 'https://agent.example.com/api/twilio/voice/deferred-poll?callSessionId=abc',
    instantSayText: 'One moment please.',
    allowTwilioSayFallback: false,
  });
  assert.doesNotMatch(xml, /<Say/);
  assert.match(xml, /<Redirect/);
});

test('deferred search filler with ElevenLabs-only uses Play or silent redirect', () => {
  const silent = buildDeferredVoiceMomentPleaseTwiML({
    deferPollUrl: 'https://agent.example.com/api/twilio/voice/deferred-poll?callSessionId=abc',
    sayFallbackText: 'Let me check.',
    allowTwilioSayFallback: false,
  });
  assert.doesNotMatch(silent, /<Say/);

  const play = buildDeferredVoiceMomentPleaseTwiML({
    deferPollUrl: 'https://agent.example.com/api/twilio/voice/deferred-poll?callSessionId=abc',
    playbackUrl: 'https://agent.example.com/api/twilio/voice/tts/abc',
    allowTwilioSayFallback: false,
  });
  assert.match(play, /<Play/);
  assert.doesNotMatch(play, /<Say/);
});

