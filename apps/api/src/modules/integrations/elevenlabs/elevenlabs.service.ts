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
    options?: { apiKey?: string; modelId?: string; styleNotes?: string },
  ): Promise<Buffer> {
    const key = options?.apiKey?.trim();
    if (!key) {
      throw new BadRequestException(
        'ElevenLabs API key is not configured for this agent. Add it in the agent form and save.',
      );
    }
    const trimmed = text.trim().slice(0, 2500);
    if (!trimmed) throw new BadRequestException('Text is required');
    const vid =
      voiceId?.trim() ||
      this.config.get<string>('ELEVENLABS_DEFAULT_VOICE_ID')?.trim() ||
      '21m00Tcm4TlvDq8ikWAM';
    const modelId =
      options?.modelId?.trim() ||
      this.config.get<string>('ELEVENLABS_MODEL_ID')?.trim() ||
      'eleven_multilingual_v2';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`;
    const body = JSON.stringify({
      text: trimmed,
      model_id: modelId,
      ...(options?.styleNotes?.trim()
        ? {
            voice_settings: {
              style: 0.45,
            },
          }
        : {}),
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
