import { Logger } from '@nestjs/common';
import WebSocket from 'ws';

export type ElevenLabsWsTtsOptions = {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  onAudioChunk: (mulawBase64: string, isFirst: boolean) => void;
  onComplete?: () => void;
  onError?: (err: Error) => void;
};

/**
 * ElevenLabs WebSocket streaming TTS — outputs ulaw_8000 for Twilio Media Streams.
 */
export class ElevenLabsWsTtsSession {
  private readonly logger = new Logger(ElevenLabsWsTtsSession.name);
  private ws: WebSocket | null = null;
  private aborted = false;
  private firstChunkSent = false;
  private markCounter = 0;

  constructor(private readonly options: ElevenLabsWsTtsOptions) {}

  async speak(text: string, signal?: AbortSignal): Promise<number> {
    const trimmed = text.trim();
    if (!trimmed || this.aborted) return 0;

    const modelId = this.options.modelId?.trim() || 'eleven_turbo_v2_5';
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.options.voiceId)}/stream-input` +
      `?model_id=${encodeURIComponent(modelId)}&output_format=ulaw_8000`;

    const started = Date.now();
    let firstChunkMs: number | null = null;

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('tts_aborted'));
        return;
      }

      this.ws = new WebSocket(url, {
        headers: { 'xi-api-key': this.options.apiKey },
      });

      const onAbort = () => {
        this.aborted = true;
        this.close();
        reject(new Error('tts_aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.ws.once('open', () => {
        this.ws?.send(
          JSON.stringify({
            text: ' ',
            voice_settings: { stability: 0.35, similarity_boost: 0.75, use_speaker_boost: false },
            generation_config: { chunk_length_schedule: [80, 120, 200, 260] },
          }),
        );
        this.ws?.send(JSON.stringify({ text: trimmed }));
        this.ws?.send(JSON.stringify({ text: '' }));
      });

      this.ws.on('message', (raw) => {
        if (this.aborted) return;
        try {
          const msg = JSON.parse(String(raw)) as { audio?: string; isFinal?: boolean; error?: string };
          if (msg.error) {
            reject(new Error(msg.error));
            return;
          }
          if (msg.audio) {
            const isFirst = !this.firstChunkSent;
            if (isFirst) {
              firstChunkMs = Date.now() - started;
              this.firstChunkSent = true;
            }
            this.options.onAudioChunk(msg.audio, isFirst);
          }
          if (msg.isFinal) {
            signal?.removeEventListener('abort', onAbort);
            this.options.onComplete?.();
            resolve();
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      this.ws.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      this.ws.on('close', () => {
        signal?.removeEventListener('abort', onAbort);
        if (!this.aborted) resolve();
      });
    }).catch((err) => {
      if ((err as Error).message !== 'tts_aborted') {
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });

    return firstChunkMs ?? Date.now() - started;
  }

  nextMarkName(): string {
    this.markCounter += 1;
    return `tts_${this.markCounter}`;
  }

  abort(): void {
    this.aborted = true;
    this.close();
  }

  private close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }
}
