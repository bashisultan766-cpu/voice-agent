import test from 'node:test';
import assert from 'node:assert/strict';
import { VoicePromptAudioService } from './voice-prompt-audio.service';

test('cached phrase playback skips ElevenLabs API on hot path', async () => {
  let elevenLabsCalls = 0;
  const fakeMpeg = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(64).fill(0)]);
  const service = new VoicePromptAudioService(
    {
      textToSpeech: async () => {
        elevenLabsCalls += 1;
        return fakeMpeg;
      },
    } as never,
    {
      put: () => 'token123',
    } as never,
  );

  const voiceId = 'voice_test';
  const model = service.resolveLatencyModelId(null);
  const text = 'Sure, let me check that for you.';

  await (service as unknown as { ensurePhraseBuffer: (...a: unknown[]) => Promise<void> }).ensurePhraseBuffer(
    text,
    voiceId,
    'sk-test',
    model,
  );

  const miss = service.resolveCachedPhrasePlaybackUrl('https://agent.example.com', {
    text: 'Unknown uncached phrase',
    voiceId,
    modelId: model,
  });
  assert.equal(miss.fromPhraseCache, false);
  assert.equal(miss.ttsGenerated, false);

  const hit = service.resolveCachedPhrasePlaybackUrl('https://agent.example.com', {
    text,
    voiceId,
    modelId: model,
  });
  assert.equal(hit.fromPhraseCache, true);
  assert.equal(hit.ttsGenerated, false);
  assert.match(hit.playbackUrl ?? '', /token123/);
  assert.equal(elevenLabsCalls, 1);
});
