import test from 'node:test';
import assert from 'node:assert/strict';
import { VoicePromptAudioService } from './voice-prompt-audio.service';

function buildService(elevenLabsCalls: { count: number }) {
  const fakeMpeg = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(64).fill(0)]);
  return new VoicePromptAudioService(
    {
      textToSpeech: async (_text: string, _voice: string, opts?: { latencyMode?: boolean }) => {
        elevenLabsCalls.count += 1;
        assert.equal(opts?.latencyMode, true);
        return fakeMpeg;
      },
    } as never,
    {
      put: () => 'token123',
    } as never,
    {
      audioHash: (_v: string, _m: string, text: string) => `hash_${text.slice(0, 24)}`,
      getBuffer: async () => null,
      setBuffer: async () => undefined,
      isEnabled: () => true,
      logCacheEvent: () => undefined,
      logCacheWarm: () => undefined,
      logWarmComplete: () => undefined,
      lastHitLayer: 'miss' as const,
    } as never,
  );
}

test('resolveLatencyModelId ignores agent multilingual model', () => {
  const prev = process.env.ELEVENLABS_LATENCY_MODEL_ID;
  process.env.ELEVENLABS_LATENCY_MODEL_ID = 'eleven_turbo_v2_5';
  try {
    const service = buildService({ count: 0 });
    assert.equal(service.resolveLatencyModelId('eleven_multilingual_v2'), 'eleven_turbo_v2_5');
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_LATENCY_MODEL_ID;
    else process.env.ELEVENLABS_LATENCY_MODEL_ID = prev;
  }
});

test('cached phrase playback skips ElevenLabs API on hot path', async () => {
  const elevenLabsCalls = { count: 0 };
  const service = buildService(elevenLabsCalls);

  const voiceId = 'voice_test';
  const model = service.resolveLatencyModelId(null);
  const text = 'Sure, let me check that for you.';

  await (service as unknown as { ensurePhraseBuffer: (...a: unknown[]) => Promise<boolean> }).ensurePhraseBuffer(
    text,
    voiceId,
    'sk-test',
    model,
  );

  const miss = await service.resolveCachedPhrasePlaybackUrl('https://agent.example.com', {
    text: 'Unknown uncached phrase',
    voiceId,
    modelId: model,
  });
  assert.equal(miss.fromPhraseCache, false);
  assert.equal(miss.audioCacheHit, false);

  const hit = await service.resolveCachedPhrasePlaybackUrl('https://agent.example.com', {
    text,
    voiceId,
    modelId: model,
  });
  assert.equal(hit.fromPhraseCache, true);
  assert.equal(hit.audioCacheHit, true);
  assert.match(hit.playbackUrl ?? '', /token123/);
  assert.equal(elevenLabsCalls.count, 1);

  const second = await service.resolveCachedPhrasePlaybackUrl('https://agent.example.com', {
    text,
    voiceId,
    modelId: model,
  });
  assert.equal(second.audioCacheHit, true);
  assert.equal(elevenLabsCalls.count, 1);
});

test('createPhrasePlaybackUrl second request hits cache without ElevenLabs', async () => {
  const elevenLabsCalls = { count: 0 };
  const service = buildService(elevenLabsCalls);
  const voiceId = 'voice_test';
  const text = "You're welcome.";

  const first = await service.createPhrasePlaybackUrl('https://agent.example.com', {
    text,
    voiceId,
    apiKey: 'sk-test',
  });
  assert.equal(first.ttsGenerated, true);
  assert.equal(first.audioCacheHit, false);
  assert.equal(elevenLabsCalls.count, 1);

  const second = await service.createPhrasePlaybackUrl('https://agent.example.com', {
    text,
    voiceId,
    apiKey: 'sk-test',
  });
  assert.equal(second.audioCacheHit, true);
  assert.equal(second.ttsGenerated, false);
  assert.equal(elevenLabsCalls.count, 1);
});
