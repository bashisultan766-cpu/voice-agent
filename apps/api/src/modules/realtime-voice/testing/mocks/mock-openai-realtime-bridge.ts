import type { OpenAiRealtimeBridgeCallbacks } from '../../media-stream/openai-realtime-bridge';

export type MockOpenAiBridgeControls = {
  appendMulawAudio: (payload: string) => void;
  emitSpeechStart: () => void;
  emitSpeechStop: () => void;
  emitPartialTranscript: (text: string) => void;
  emitFinalTranscript: (text: string) => void;
  emitError: (message: string) => void;
  close: () => void;
  getSttLatencyMs: () => number | null;
};

export class MockOpenAiRealtimeBridge {
  readonly appendedAudio: string[] = [];
  private speechStartedAt: number | null = null;
  private closed = false;

  constructor(private readonly callbacks: OpenAiRealtimeBridgeCallbacks) {}

  async connect(): Promise<void> {
    this.callbacks.onConnected?.();
  }

  appendMulawAudio(base64Payload: string): void {
    if (this.closed) return;
    this.appendedAudio.push(base64Payload);
  }

  getSttLatencyMs(): number | null {
    if (!this.speechStartedAt) return null;
    return Date.now() - this.speechStartedAt;
  }

  close(): void {
    this.closed = true;
  }

  controls(): MockOpenAiBridgeControls {
    return {
      appendMulawAudio: (p) => this.appendMulawAudio(p),
      emitSpeechStart: () => {
        this.speechStartedAt = Date.now();
        this.callbacks.onSpeechStart?.();
      },
      emitSpeechStop: () => this.callbacks.onSpeechStop?.(),
      emitPartialTranscript: (t) => this.callbacks.onPartialTranscript?.(t),
      emitFinalTranscript: (t) => this.callbacks.onFinalTranscript(t),
      emitError: (m) => this.callbacks.onError?.(new Error(m)),
      close: () => this.close(),
      getSttLatencyMs: () => this.getSttLatencyMs(),
    };
  }
}

export function createMockOpenAiBridgeFactory(
  instances: MockOpenAiRealtimeBridge[],
  connectDelayMs = 5,
  shouldFailConnect = false,
) {
  return {
    async createBridge(input: OpenAiRealtimeBridgeCallbacks & { apiKey: string }) {
      if (shouldFailConnect) {
        throw new Error('openai_realtime_connect_failed');
      }
      await new Promise((r) => setTimeout(r, connectDelayMs));
      const bridge = new MockOpenAiRealtimeBridge({
        onSpeechStart: input.onSpeechStart,
        onSpeechStop: input.onSpeechStop,
        onPartialTranscript: input.onPartialTranscript,
        onFinalTranscript: input.onFinalTranscript,
        onError: input.onError,
        onConnected: input.onConnected,
      });
      await bridge.connect();
      instances.push(bridge);
      return bridge;
    },
    isEnabled: () => true,
    resolveModel: () => 'gpt-4o-mini-realtime-preview',
  };
}
