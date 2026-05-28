import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLlmReplyMetadataPatch,
  isHiddenFillerReply,
  readLlmReplyFromMetadata,
  shouldBlockNonOrchestratorTts,
} from './voice-single-reply-pipeline.util';

test('buildLlmReplyMetadataPatch marks generated', () => {
  const p = buildLlmReplyMetadataPatch('Hello from brain');
  assert.equal(p.llmReplyGenerated, true);
  assert.equal(p.llmFinalReplyText, 'Hello from brain');
});

test('blocks phrase audio after llm reply for different text', () => {
  const meta = buildLlmReplyMetadataPatch('I am doing well. What book can I help you find?');
  const blocked = shouldBlockNonOrchestratorTts({
    metadata: meta,
    candidateText: 'Thanks',
    sourceFunction: 'deferred_kickoff',
  });
  assert.ok(blocked);
  assert.equal(blocked?.originalChars, 6);
});

test('allows orchestrator final text through', () => {
  const meta = buildLlmReplyMetadataPatch('Exact orchestrator line.');
  const blocked = shouldBlockNonOrchestratorTts({
    metadata: meta,
    candidateText: 'Exact orchestrator line.',
    sourceFunction: 'buildElevenLabsPlaybackUrl:gather_reply',
  });
  assert.equal(blocked, null);
});

test('detects hidden fillers', () => {
  assert.equal(isHiddenFillerReply('Thanks'), true);
  assert.equal(isHiddenFillerReply('Hello'), true);
  assert.equal(isHiddenFillerReply('Sure.'), true);
});

test('readLlmReplyFromMetadata', () => {
  const { generated, finalText } = readLlmReplyFromMetadata({
    llmReplyGenerated: true,
    llmFinalReplyText: 'Hi there',
  });
  assert.equal(generated, true);
  assert.equal(finalText, 'Hi there');
});
