import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeGatherSpeechGate, hasMeaningfulSpeech } from './gather-speech-gate.util';

describe('hasMeaningfulSpeech', () => {
  it('accepts real sentences regardless of confidence', () => {
    assert.equal(hasMeaningfulSpeech('How are you?'), true);
    assert.equal(hasMeaningfulSpeech('Hello'), true);
    assert.equal(hasMeaningfulSpeech('I need a book'), true);
    assert.equal(hasMeaningfulSpeech('History book'), true);
    assert.equal(hasMeaningfulSpeech('Atomic habits'), true);
    assert.equal(hasMeaningfulSpeech('I need a history book'), true);
  });

  it('rejects empty, too short, and noise-only transcripts', () => {
    assert.equal(hasMeaningfulSpeech(''), false);
    assert.equal(hasMeaningfulSpeech(' '), false);
    assert.equal(hasMeaningfulSpeech('a'), false);
    assert.equal(hasMeaningfulSpeech('uh'), false);
    assert.equal(hasMeaningfulSpeech('um'), false);
    assert.equal(hasMeaningfulSpeech('hmm'), false);
    assert.equal(hasMeaningfulSpeech('.'), false);
    assert.equal(hasMeaningfulSpeech('...'), false);
  });
});

describe('computeGatherSpeechGate', () => {
  it('accepts SpeechResult with Confidence 0.0 and routes to voice runtime', () => {
    const gate = computeGatherSpeechGate({
      SpeechResult: 'How are you?',
      Confidence: '0.0',
    });

    assert.equal(gate.hasUsableSpeech, true);
    assert.equal(gate.willCallVoiceRuntime, true);
    assert.equal(gate.speechAccepted, true);
    assert.equal(gate.acceptReason, 'meaningful_text');
    assert.equal(gate.rejectReason, null);
    assert.equal(gate.confidenceParsed, 0);
  });

  it('accepts book request with Confidence 0.0 for Shopify search flow', () => {
    const gate = computeGatherSpeechGate({
      SpeechResult: 'I need a history book',
      Confidence: '0.0',
    });

    assert.equal(gate.hasUsableSpeech, true);
    assert.equal(gate.willCallVoiceRuntime, true);
    assert.equal(gate.speechTextMerged, 'I need a history book');
  });

  it('rejects empty SpeechResult and does not call voice runtime', () => {
    const gate = computeGatherSpeechGate({
      SpeechResult: '',
      Confidence: '0.0',
    });

    assert.equal(gate.hasUsableSpeech, false);
    assert.equal(gate.willCallVoiceRuntime, false);
    assert.equal(gate.rejectReason, 'empty');
    assert.equal(gate.acceptReason, null);
  });

  it('uses StableSpeechResult when SpeechResult is empty', () => {
    const gate = computeGatherSpeechGate({
      SpeechResult: '',
      StableSpeechResult: 'Hello there',
      Confidence: '0.0',
    });

    assert.equal(gate.speechTextMerged, 'Hello there');
    assert.equal(gate.willCallVoiceRuntime, true);
  });
});
