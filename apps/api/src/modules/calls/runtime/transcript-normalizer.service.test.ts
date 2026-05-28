import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type OpenAI from 'openai';
import type { TranscriptNormalizeCompletionFn } from './transcript-normalizer.service';
import { TranscriptNormalizerService } from './transcript-normalizer.service';

function mockCompletion(reply: string): TranscriptNormalizeCompletionFn {
  return async () =>
    ({
      choices: [{ message: { content: reply } }],
    }) as OpenAI.Chat.ChatCompletion;
}

function buildService(completionReply: string) {
  const service = new TranscriptNormalizerService(
    { get: () => 'sk-test' } as never,
    {
      load: async () => ({
        agent: { openaiApiKey: 'sk-test' },
      }),
    } as never,
    {
      productCache: {
        findMany: async () => [
          { title: 'A Feast for Crows', vendor: 'Bantam' },
          { title: 'Atomic Habits', vendor: null },
          { title: 'Rich Dad Poor Dad', vendor: null },
        ],
      },
    } as never,
  );
  return { service, completionFn: mockCompletion(completionReply) };
}

const ctx = {
  tenantId: 'tenant_1',
  agentId: 'agent_1',
  callSessionId: 'sess_1',
};

describe('TranscriptNormalizerService', () => {
  it('corrects feast for crows STT error', async () => {
    const { service, completionFn } = buildService('A Feast for Crows: A Song of Ice and Fire');
    const result = await service.normalizeTranscript('A feast uh for close a song of ice', ctx, {
      completionFn,
    });
    assert.equal(result.normalized, 'A Feast for Crows: A Song of Ice and Fire');
    assert.equal(result.corrected, true);
    assert.ok(result.confidence === 'high' || result.confidence === 'medium');
  });

  it('corrects rich dad poor dead', async () => {
    const { service, completionFn } = buildService('Rich Dad Poor Dad');
    const result = await service.normalizeTranscript('rich dad poor dead', ctx, { completionFn });
    assert.equal(result.normalized, 'Rich Dad Poor Dad');
    assert.equal(result.corrected, true);
  });

  it('corrects atomic hobbits to atomic habits', async () => {
    const { service, completionFn } = buildService('Atomic Habits');
    const result = await service.normalizeTranscript('atomic hobbits', ctx, { completionFn });
    assert.equal(result.normalized, 'Atomic Habits');
    assert.equal(result.corrected, true);
  });

  it('skips trivial greetings without calling the model', async () => {
    const { service } = buildService('Hello');
    let called = false;
    const result = await service.normalizeTranscript('hello', ctx, {
      completionFn: async () => {
        called = true;
        return { choices: [{ message: { content: 'Hello' } }] } as OpenAI.Chat.ChatCompletion;
      },
    });
    assert.equal(called, false);
    assert.equal(result.skipped, true);
    assert.equal(result.normalized, 'hello');
  });
});
