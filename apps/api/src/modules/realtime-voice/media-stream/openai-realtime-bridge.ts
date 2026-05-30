import { Logger } from '@nestjs/common';
import WebSocket from 'ws';

export type OpenAiRealtimeBridgeCallbacks = {
  onSpeechStart?: () => void;
  onSpeechStop?: () => void;
  onPartialTranscript?: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onError?: (error: Error) => void;
  onConnected?: () => void;
};

export type OpenAiRealtimeBridgeOptions = {
  apiKey: string;
  model?: string;
  instructions?: string;
};

/**
 * WebSocket bridge to OpenAI Realtime API — streams g711_ulaw audio, emits transcripts + VAD events.
 */
export class OpenAiRealtimeBridge {
  private readonly logger = new Logger(OpenAiRealtimeBridge.name);
  private ws: WebSocket | null = null;
  private closed = false;
  private speechStartedAt: number | null = null;

  constructor(
    private readonly options: OpenAiRealtimeBridgeOptions,
    private readonly callbacks: OpenAiRealtimeBridgeCallbacks,
  ) {}

  async connect(): Promise<void> {
    const model = this.options.model ?? 'gpt-4o-mini-realtime-preview';
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      const failTimer = setTimeout(() => {
        reject(new Error('openai_realtime_connect_timeout'));
      }, 10_000);

      this.ws.once('open', () => {
        clearTimeout(failTimer);
        this.sendSessionUpdate();
        this.callbacks.onConnected?.();
        resolve();
      });

      this.ws.once('error', (err) => {
        clearTimeout(failTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      this.ws.on('message', (raw) => this.handleMessage(String(raw)));
      this.ws.on('close', () => {
        this.closed = true;
      });
      this.ws.on('error', (err) => {
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  appendMulawAudio(base64Payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) return;
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Payload }));
  }

  getSttLatencyMs(): number | null {
    if (!this.speechStartedAt) return null;
    return Date.now() - this.speechStartedAt;
  }

  close(): void {
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  private sendSessionUpdate(): void {
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions:
          this.options.instructions ??
          'Transcribe the caller accurately. Do not respond — transcription only.',
        input_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        input_audio_transcription: { model: 'whisper-1' },
      },
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(msg.type ?? '');

    if (type === 'input_audio_buffer.speech_started') {
      this.speechStartedAt = Date.now();
      this.callbacks.onSpeechStart?.();
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      this.callbacks.onSpeechStop?.();
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(msg.transcript ?? '').trim();
      if (transcript) {
        this.callbacks.onFinalTranscript(transcript);
      }
      this.speechStartedAt = null;
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.delta') {
      const delta = String(msg.delta ?? '');
      if (delta) this.callbacks.onPartialTranscript?.(delta);
      return;
    }

    if (type === 'error') {
      const errObj = msg.error as { message?: string } | undefined;
      this.callbacks.onError?.(new Error(errObj?.message ?? 'openai_realtime_error'));
    }
  }
}
