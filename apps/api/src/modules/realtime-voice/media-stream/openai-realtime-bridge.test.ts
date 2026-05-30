import test from 'node:test';
import assert from 'node:assert/strict';

test('OpenAiRealtimeBridge handles transcription completed event', async () => {
  const { OpenAiRealtimeBridge } = await import('./openai-realtime-bridge');

  let finalText = '';
  const bridge = new OpenAiRealtimeBridge(
    { apiKey: 'test', model: 'gpt-4o-mini-realtime-preview' },
    {
      onFinalTranscript: (t) => {
        finalText = t;
      },
    },
  );

  const handler = (bridge as unknown as { handleMessage: (raw: string) => void }).handleMessage.bind(bridge);
  handler(
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Do you have Dune?',
    }),
  );

  assert.equal(finalText, 'Do you have Dune?');
});

test('OpenAiRealtimeBridge speech_started triggers callback', async () => {
  const { OpenAiRealtimeBridge } = await import('./openai-realtime-bridge');

  let speechStarted = false;
  const bridge = new OpenAiRealtimeBridge(
    { apiKey: 'test' },
    {
      onFinalTranscript: () => undefined,
      onSpeechStart: () => {
        speechStarted = true;
      },
    },
  );

  const handler = (bridge as unknown as { handleMessage: (raw: string) => void }).handleMessage.bind(bridge);
  handler(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  assert.equal(speechStarted, true);
});
