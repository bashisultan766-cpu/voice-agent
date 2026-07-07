/**
 * Telephony audio helpers — PCM → μ-law 8 kHz for Twilio Media Streams.
 * OpenAI TTS returns 24 kHz PCM16LE; Twilio outbound expects μ-law @ 8 kHz.
 */

/** OpenAI speech API PCM sample rate (16-bit mono LE). */
export const OPENAI_TTS_PCM_SAMPLE_RATE = 24_000;

export const TWILIO_MULAW_SAMPLE_RATE = 8_000;

export type TelephonySourceFormat = "ulaw_8000" | "pcm_16000" | "pcm_24000";

/** μ-law silence / comfort-noise byte (G.711 idle line). */
export const MULAW_SILENCE_BYTE = 0xff;

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32_635;

function linearSampleToMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let magnitude = sample < 0 ? -sample : sample;
  if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;
  magnitude += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; exponent--) {
    mask >>= 1;
  }

  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function pcm16leToMulaw(pcm16le: Buffer): Buffer {
  const sampleCount = Math.floor(pcm16le.length / 2);
  const out = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = linearSampleToMulaw(pcm16le.readInt16LE(i * 2));
  }
  return out;
}

/** Downsample PCM16LE (e.g. 24 kHz → 8 kHz) via linear interpolation. */
export function resamplePcm16le(
  pcm16le: Buffer,
  fromRate: number,
  toRate: number,
): Buffer {
  if (fromRate === toRate) return pcm16le;

  const inputSamples = Math.floor(pcm16le.length / 2);
  if (inputSamples === 0) return Buffer.alloc(0);

  const outputSamples = Math.max(1, Math.floor((inputSamples * toRate) / fromRate));
  const out = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = (i * fromRate) / toRate;
    const idx = Math.min(Math.floor(srcPos), inputSamples - 1);
    out.writeInt16LE(pcm16le.readInt16LE(idx * 2), i * 2);
  }

  return out;
}

export function pcm16leToMulaw8k(
  pcm16le: Buffer,
  inputSampleRate = OPENAI_TTS_PCM_SAMPLE_RATE,
): Buffer {
  const at8k = resamplePcm16le(pcm16le, inputSampleRate, TWILIO_MULAW_SAMPLE_RATE);
  return pcm16leToMulaw(at8k);
}

/** Normalize any telephony TTS buffer to μ-law @ 8 kHz for Twilio Media Streams. */
export function toTwilioMulaw8k(
  audio: Buffer,
  sourceFormat: TelephonySourceFormat = "ulaw_8000",
): Buffer {
  if (!audio.length || sourceFormat === "ulaw_8000") {
    return audio;
  }
  const sampleRate =
    sourceFormat === "pcm_16000" ? 16_000 : OPENAI_TTS_PCM_SAMPLE_RATE;
  return pcm16leToMulaw8k(audio, sampleRate);
}

/** Build a comfort-noise frame (μ-law silence) for stream keepalive. */
export function buildComfortNoisePacket(byteLength = 160): Buffer {
  return Buffer.alloc(byteLength, MULAW_SILENCE_BYTE);
}

export function chunkBuffer(buffer: Buffer, frameBytes: number): Buffer[] {
  if (!buffer.length) return [];
  const frames: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += frameBytes) {
    frames.push(buffer.subarray(offset, Math.min(offset + frameBytes, buffer.length)));
  }
  return frames;
}
