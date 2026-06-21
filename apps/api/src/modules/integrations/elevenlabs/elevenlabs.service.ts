import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  logElevenLabsModelSelected,
  resolveElevenLabsVoiceModel,
} from './elevenlabs-voice-model.util';

@Injectable()
export class ElevenLabsService {
  private readonly logger = new Logger(ElevenLabsService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Synthesize speech via ElevenLabs REST API (mp3). Used for voice provider = elevenlabs.
   */
  async textToSpeech(
    text: string,
    voiceId?: string,
    options?: {
      apiKey?: string;
      modelId?: string;
      latencyMode?: boolean;
      /** Live Twilio voice call — env latency model wins over agent model. */
      voiceCall?: boolean;
      callSessionId?: string;
    },
  ): Promise<Buffer> {
    const key = options?.apiKey?.trim();
    if (!key) {
      throw new BadRequestException(
        'ElevenLabs API key is not configured for this agent. Add it in the agent form and save.',
      );
    }
    const trimmed = text.trim().slice(0, 2500);
    if (!trimmed) throw new BadRequestException('Text is required');
    const vid = voiceId?.trim();
    if (!vid) {
      throw new BadRequestException(
        'ElevenLabs voice ID is required on the agent. Save a single voice ID in agent settings.',
      );
    }

    const isVoiceCall = options?.voiceCall === true || options?.latencyMode === true;
    const modelPick = resolveElevenLabsVoiceModel({
      agentModelId: options?.modelId,
      forceVoiceLatency: isVoiceCall,
      envLatencyModelId: this.config.get<string>('ELEVENLABS_LATENCY_MODEL_ID'),
      envDefaultModelId: this.config.get<string>('ELEVENLABS_MODEL_ID'),
    });
    logElevenLabsModelSelected(modelPick, {
      callSessionId: options?.callSessionId ?? null,
      voiceCall: isVoiceCall,
      latencyMode: options?.latencyMode === true,
    });

    const modelId = modelPick.selectedModel;
    const latencyMode = options?.latencyMode === true || isVoiceCall;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`;
    const body = JSON.stringify({
      text: trimmed,
      model_id: modelId,
      voice_settings: latencyMode
        ? { stability: 0.35, similarity_boost: 0.75, style: 0, use_speaker_boost: false }
        : {
            stability: 0.5,
            similarity_boost: 0.8,
            style: 0,
            use_speaker_boost: true,
          },
    });

    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'xi-api-key': key,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body,
        });
        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 429 || res.status === 402) {
            this.logger.warn(
              JSON.stringify({
                event: 'elevenlabs.quota_or_rate_limit',
                status: res.status,
                detail: errText.slice(0, 120),
              }),
            );
          }
          throw new BadRequestException(`ElevenLabs error ${res.status}: ${errText.slice(0, 200)}`);
        }
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        lastNetworkError = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
        }
      }
    }
    throw lastNetworkError instanceof Error ? lastNetworkError : new Error('ElevenLabs fetch failed after retries');
  }
}
