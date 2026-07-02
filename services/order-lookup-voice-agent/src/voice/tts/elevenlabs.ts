/**
 * Direct ElevenLabs TTS — Twilio never generates voice.
 * POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
 */
import { getConfig } from "../../config.js";
import { smoothForVoice } from "../../services/voiceSmoothingEngine.js";
import { logger } from "../../utils/logger.js";

export interface ElevenLabsSynthesisResult {
  audio: Buffer;
  contentType: string;
}

const DEFAULT_TIMEOUT_MS = 12_000;

export function prepareSpeechText(text: string): string {
  return smoothForVoice(
    text
      .replace(/\s*—\s*/g, "... ")
      .replace(/\.\.\./g, "... ")
      .trim(),
  );
}

export function getElevenLabsVoiceId(): string {
  const cfg = getConfig();
  return (cfg.VOICE_ID || cfg.ELEVENLABS_VOICE_ID || "").trim();
}

export async function synthesizeSpeech(text: string): Promise<ElevenLabsSynthesisResult> {
  const cfg = getConfig();
  const apiKey = cfg.ELEVENLABS_API_KEY;
  const voiceId = getElevenLabsVoiceId();

  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is required");
  }
  if (!voiceId) {
    throw new Error("VOICE_ID or ELEVENLABS_VOICE_ID is required");
  }

  const prepared = prepareSpeechText(text);
  if (!prepared) {
    throw new Error("empty_speech_text");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: prepared,
          model_id: cfg.ELEVENLABS_MODEL,
          voice_settings: {
            stability: cfg.VOICE_STABILITY,
            similarity_boost: cfg.VOICE_SIMILARITY,
            style: 0.22,
            use_speaker_boost: true,
          },
        }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      logger.error("elevenlabs_tts_failed", {
        status: res.status,
        body: body.slice(0, 200),
      });
      throw new Error(`elevenlabs_http_${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: res.headers.get("content-type") ?? "audio/mpeg",
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("elevenlabs_")) {
      throw err;
    }
    logger.error("elevenlabs_tts_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
