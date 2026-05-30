import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { OpenAiRealtimeBridge, type OpenAiRealtimeBridgeCallbacks } from './openai-realtime-bridge';

export type CreateBridgeInput = OpenAiRealtimeBridgeCallbacks & {
  apiKey: string;
  model?: string;
  instructions?: string;
};

@Injectable()
export class OpenAiRealtimeBridgeService {
  private readonly logger = new Logger(OpenAiRealtimeBridgeService.name);

  constructor(private readonly config: ConfigService) {}

  resolveModel(override?: string): string {
    return (
      override?.trim() ||
      this.config.get<string>('OPENAI_REALTIME_MODEL')?.trim() ||
      'gpt-4o-mini-realtime-preview'
    );
  }

  async createBridge(input: CreateBridgeInput): Promise<OpenAiRealtimeBridge> {
    const bridge = new OpenAiRealtimeBridge(
      {
        apiKey: input.apiKey,
        model: this.resolveModel(input.model),
        instructions: input.instructions,
      },
      {
        onSpeechStart: input.onSpeechStart,
        onSpeechStop: input.onSpeechStop,
        onPartialTranscript: input.onPartialTranscript,
        onFinalTranscript: input.onFinalTranscript,
        onError: input.onError,
        onConnected: input.onConnected,
      },
    );
    await bridge.connect();
    return bridge;
  }

  isEnabled(): boolean {
    return this.config.get<string>('OPENAI_REALTIME_ENABLED') === 'true';
  }
}
