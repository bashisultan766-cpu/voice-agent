import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveElevenLabsVoiceModel,
} from './elevenlabs-voice-model.util';
import { ElevenLabsService } from './elevenlabs.service';

test('voice call forces ELEVENLABS_LATENCY_MODEL_ID over agent multilingual model', () => {
  const prev = process.env.ELEVENLABS_LATENCY_MODEL_ID;
  process.env.ELEVENLABS_LATENCY_MODEL_ID = 'eleven_turbo_v2_5';
  try {
    const result = resolveElevenLabsVoiceModel({
      agentModelId: 'eleven_multilingual_v2',
      forceVoiceLatency: true,
    });
    assert.equal(result.selectedModel, 'eleven_turbo_v2_5');
    assert.equal(result.source, 'env');
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_LATENCY_MODEL_ID;
    else process.env.ELEVENLABS_LATENCY_MODEL_ID = prev;
  }
});

test('voice call defaults to turbo when env unset', () => {
  const prev = process.env.ELEVENLABS_LATENCY_MODEL_ID;
  delete process.env.ELEVENLABS_LATENCY_MODEL_ID;
  try {
    const result = resolveElevenLabsVoiceModel({
      agentModelId: 'eleven_multilingual_v2',
      forceVoiceLatency: true,
    });
    assert.equal(result.selectedModel, 'eleven_turbo_v2_5');
    assert.equal(result.source, 'default');
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_LATENCY_MODEL_ID;
    else process.env.ELEVENLABS_LATENCY_MODEL_ID = prev;
  }
});

test('ElevenLabs textToSpeech uses turbo model for voice calls', async () => {
  const prev = process.env.ELEVENLABS_LATENCY_MODEL_ID;
  process.env.ELEVENLABS_LATENCY_MODEL_ID = 'eleven_turbo_v2_5';
  let capturedModel = '';
  const service = new ElevenLabsService({
    get: () => undefined,
  } as never);
  const origFetch = global.fetch;
  global.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model_id?: string };
    capturedModel = body.model_id ?? '';
    return new Response(Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(32).fill(0)]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  }) as typeof fetch;
  try {
    await service.textToSpeech('Hello', 'voice_1', {
      apiKey: 'sk-test',
      modelId: 'eleven_multilingual_v2',
      latencyMode: true,
      voiceCall: true,
    });
    assert.equal(capturedModel, 'eleven_turbo_v2_5');
    assert.notEqual(capturedModel, 'eleven_multilingual_v2');
  } finally {
    global.fetch = origFetch;
    if (prev === undefined) delete process.env.ELEVENLABS_LATENCY_MODEL_ID;
    else process.env.ELEVENLABS_LATENCY_MODEL_ID = prev;
  }
});

test('logElevenLabsModelSelected result includes env source for voice calls', () => {
  const result = resolveElevenLabsVoiceModel({
    agentModelId: 'eleven_multilingual_v2',
    forceVoiceLatency: true,
    envLatencyModelId: 'eleven_turbo_v2_5',
  });
  assert.equal(result.selectedModel, 'eleven_turbo_v2_5');
  assert.equal(result.source, 'env');
  assert.equal(result.agentModel, 'eleven_multilingual_v2');
});
