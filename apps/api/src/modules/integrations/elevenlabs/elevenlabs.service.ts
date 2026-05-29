import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ElevenLabsService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Synthesize speech via ElevenLabs REST API (mp3). Used for voice provider = elevenlabs.
   */
  async textToSpeech(
    text: string,
    voiceId?: string,
    options?: { apiKey?: string; modelId?: string; latencyMode?: boolean },
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
    const modelId =
      options?.modelId?.trim() ||
      (options?.latencyMode
        ? this.config.get<string>('ELEVENLABS_LATENCY_MODEL_ID')?.trim()
        : undefined) ||
      this.config.get<string>('ELEVENLABS_MODEL_ID')?.trim() ||
      (options?.latencyMode ? 'eleven_turbo_v2_5' : 'eleven_multilingual_v2');
    const latencyMode = options?.latencyMode === true;
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
