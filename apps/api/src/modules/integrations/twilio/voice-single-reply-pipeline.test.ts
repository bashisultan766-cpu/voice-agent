import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockNonOrchestratorTts } from '../../calls/runtime/voice-single-reply-pipeline.util';

test('after llm reply blocks gather_retry_final_fallback phrase text', () => {
  const blocked = shouldBlockNonOrchestratorTts({
    metadata: {
      llmReplyGenerated: true,
      llmFinalReplyText: 'I found World History for $24.99. Would you like to order it?',
    },
    candidateText: "We're having trouble hearing you. Please call again later. Goodbye.",
    sourceFunction: 'gather_retry_final_fallback',
  });
  assert.ok(blocked);
  assert.match(blocked!.reason, /llm_reply_already_generated/);
});

test('empty speech retry allowed without llm flag', () => {
  const blocked = shouldBlockNonOrchestratorTts({
    metadata: {},
    candidateText: "Sorry, I didn't catch that. Could you please repeat it?",
    sourceFunction: 'gather_retry_opening',
    allowEmptySpeechRetry: true,
  });
  assert.equal(blocked, null);
});
