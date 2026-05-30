import { ElevenLabsWsTtsSession } from '../../media-stream/elevenlabs-ws-tts';

export type MockTtsSpeakCall = {
  text: string;
  aborted: boolean;
};

let mockFirstChunkMs = 45;
let mockShouldFail = false;
let speakCalls: MockTtsSpeakCall[] = [];

export function resetMockElevenLabsTts(): void {
  mockFirstChunkMs = 45;
  mockShouldFail = false;
  speakCalls = [];
}

export function setMockElevenLabsFirstChunkMs(ms: number): void {
  mockFirstChunkMs = ms;
}

export function setMockElevenLabsShouldFail(fail: boolean): void {
  mockShouldFail = fail;
}

export function getMockElevenLabsSpeakCalls(): MockTtsSpeakCall[] {
  return [...speakCalls];
}

let installed = false;
let originalSpeak: ElevenLabsWsTtsSession['speak'] | null = null;
let originalMark: ElevenLabsWsTtsSession['nextMarkName'] | null = null;

/** Patch ElevenLabsWsTtsSession — import ./register-mocks before test-harness. */
export function installMockElevenLabsTtsPatch(): () => void {
  if (installed) {
    return () => undefined;
  }

  originalSpeak = ElevenLabsWsTtsSession.prototype.speak;
  originalMark = ElevenLabsWsTtsSession.prototype.nextMarkName;

  ElevenLabsWsTtsSession.prototype.speak = async function mockSpeak(
    text: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const aborted = signal?.aborted ?? false;
    speakCalls.push({ text, aborted });

    if (mockShouldFail) {
      throw new Error('elevenlabs_ws_tts_failed');
    }

    if (aborted) return 0;

    await new Promise((r) => setTimeout(r, mockFirstChunkMs));

    if (signal?.aborted) {
      speakCalls[speakCalls.length - 1].aborted = true;
      return 0;
    }

    const self = this as unknown as { options: { onAudioChunk?: (a: string, f: boolean) => void } };
    self.options?.onAudioChunk?.('mock_mulaw_audio_chunk', true);

    return mockFirstChunkMs;
  };

  ElevenLabsWsTtsSession.prototype.nextMarkName = function mockMark() {
    return `tts_mock_${speakCalls.length}`;
  };

  installed = true;

  return () => {
    if (originalSpeak) ElevenLabsWsTtsSession.prototype.speak = originalSpeak;
    if (originalMark) ElevenLabsWsTtsSession.prototype.nextMarkName = originalMark;
    installed = false;
    resetMockElevenLabsTts();
  };
}
