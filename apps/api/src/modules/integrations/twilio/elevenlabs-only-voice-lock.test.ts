import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoTwilioSayInTwiml,
  resolveVoiceProviderActuallyUsed,
  resolveVoiceProviderPolicy,
  twimlContainsSay,
} from './voice-provider-policy.util';
import {
  buildDeferredVoiceKickoffTwiML,
  buildDeferredVoiceMomentPleaseTwiML,
  buildDeferredVoicePollPauseTwiML,
  buildInboundGatherMvpTwiML,
  buildVoiceTerminalTwiml,
} from './twiml/gather-mvp.twiml';
import { buildFallbackTwiML } from './twiml/conversation-relay.twiml';

const pollUrl = 'https://agent.example.com/api/twilio/voice/deferred-poll?callSessionId=abc';
const gatherUrl = 'https://agent.example.com/api/twilio/voice/gather?callSessionId=abc';

const elOnlyPolicy = resolveVoiceProviderPolicy({
  FORCE_ELEVENLABS_ONLY: 'true',
  STRICT_ELEVENLABS_ONLY: 'true',
});

test('FORCE_ELEVENLABS_ONLY sets disableTwilioSayCompletely', () => {
  assert.equal(elOnlyPolicy.disableTwilioSayCompletely, true);
  assert.equal(elOnlyPolicy.twilioSayBlocked, true);
});

test('no TwiML contains Say when blockTwilioSay is set on all MVP builders', () => {
  const cases = [
    buildInboundGatherMvpTwiML({
      gatherActionUrl: gatherUrl,
      openingSayText: 'Hello',
      finalFallbackSayText: 'Goodbye',
      blockTwilioSay: true,
    }),
    buildDeferredVoiceKickoffTwiML({
      deferPollUrl: pollUrl,
      instantSayText: 'One moment.',
      allowTwilioSayFallback: true,
      blockTwilioSay: true,
    }),
    buildDeferredVoiceMomentPleaseTwiML({
      deferPollUrl: pollUrl,
      sayFallbackText: 'Let me check.',
      allowTwilioSayFallback: true,
      blockTwilioSay: true,
    }),
    buildDeferredVoicePollPauseTwiML({ deferPollUrl: pollUrl }),
    buildVoiceTerminalTwiml({
      sayText: 'Thanks for calling.',
      blockTwilioSay: true,
    }),
    buildFallbackTwiML('Error message', { blockTwilioSay: true }),
  ];
  for (const xml of cases) {
    assert.doesNotMatch(xml, /<Say/i, `unexpected Say in: ${xml.slice(0, 120)}`);
    assertNoTwilioSayInTwiml(xml, elOnlyPolicy);
  }
});

test('deferred kickoff without audio uses silent redirect only in ElevenLabs-only mode', () => {
  const xml = buildDeferredVoiceKickoffTwiML({
    deferPollUrl: pollUrl,
    instantSayText: 'One moment please.',
    allowTwilioSayFallback: false,
    blockTwilioSay: true,
  });
  assert.doesNotMatch(xml, /<Say/i);
  assert.match(xml, /<Redirect/);
  assert.equal(resolveVoiceProviderActuallyUsed(false, elOnlyPolicy), 'elevenlabs_silent_wait');
});

test('assertNoTwilioSayInTwiml throws when Say is present in ElevenLabs-only mode', () => {
  const xml = buildDeferredVoiceKickoffTwiML({
    deferPollUrl: pollUrl,
    allowTwilioSayFallback: true,
  });
  assert.equal(twimlContainsSay(xml), true);
  assert.throws(() => assertNoTwilioSayInTwiml(xml, elOnlyPolicy), /Twilio SAY blocked/);
});

test('twilio_say_fallback is not used in logs mapping when ElevenLabs-only without playback', () => {
  const used = resolveVoiceProviderActuallyUsed(false, elOnlyPolicy);
  assert.equal(used, 'elevenlabs_silent_wait');
  assert.notEqual(used, 'twilio_say_fallback');
});
