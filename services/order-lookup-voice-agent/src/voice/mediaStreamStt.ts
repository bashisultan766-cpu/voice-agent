/**
 * Inbound mulaw buffer → OpenAI Whisper transcription for Media Streams.
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";

const MULAW_SAMPLE_RATE = 8000;

/** Wrap 8-bit μ-law payload in a minimal WAV container for Whisper. */
export function mulawBufferToWav(mulaw: Buffer): Buffer {
  const dataSize = mulaw.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20); // μ-law
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(MULAW_SAMPLE_RATE, 24);
  header.writeUInt32LE(MULAW_SAMPLE_RATE, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, mulaw]);
}

export async function transcribeMulawBuffer(mulaw: Buffer): Promise<string> {
  if (!mulaw.length) return "";

  const cfg = getConfig();
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const wav = mulawBufferToWav(mulaw);
  const file = new File([new Uint8Array(wav)], "caller.wav", { type: "audio/wav" });

  try {
    const result = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "en",
    });
    return (result.text ?? "").trim();
  } catch (err) {
    logger.warn("media_stream_stt_failed", {
      error: err instanceof Error ? err.message : String(err),
      bytes: mulaw.length,
    });
    return "";
  }
}
