import type { SpeechChunk } from "../types/order.js";
import {
  MAX_AUDIO_CHUNK_BYTES,
  MIN_AUDIO_CHUNK_BYTES,
  resolveTelephonyOutputFormat,
  synthesizeSpeechStream,
  type TtsEngineName,
} from "../adapters/ttsAdapter.js";
import { sanitizeTextForTTS } from "../utils/ttsFormatter.js";
import { buildComfortNoisePacket, toTwilioMulaw8k, type TelephonySourceFormat } from "../utils/telephonyAudio.js";
import type { MediaStreamOutboundMessage } from "../voice/mediaStreamProtocol.js";
import { logger } from "../utils/logger.js";

export type MediaStreamSendFn = (msg: MediaStreamOutboundMessage) => void;

export interface StreamAudioOptions {
  abortSignal?: AbortSignal;
  streamSid: string;
  onAudioSent?: () => void;
}

const lastOutboundAudioAt = new Map<string, number>();

export function touchOutboundAudio(callSid: string): void {
  lastOutboundAudioAt.set(callSid, Date.now());
}

export function getLastOutboundAudioAt(callSid: string): number {
  return lastOutboundAudioAt.get(callSid) ?? 0;
}

export function clearOutboundAudioTracking(callSid: string): void {
  lastOutboundAudioAt.delete(callSid);
}

/** TTS adapter yields telephony-ready μ-law for both ElevenLabs and OpenAI paths. */
function telephonyFramesFromChunk(audio: Buffer): Buffer[] {
  return audio.length <= MAX_AUDIO_CHUNK_BYTES
    ? [audio]
    : chunkBufferTelephony(audio);
}

/**
 * Single outbound audio path to Twilio Media Streams.
 * All TTS / comfort-noise must pass through here.
 */
export function sendAudio(
  send: MediaStreamSendFn,
  streamSid: string,
  audio: Buffer,
  callSid?: string,
  sourceFormat?: TelephonySourceFormat,
): void {
  if (!audio.length) return;

  const telephonyMulaw = toTwilioMulaw8k(
    audio,
    sourceFormat ?? resolveTelephonyOutputFormat(),
  );
  const payload = telephonyMulaw.toString("base64");

  logger.debug("media_stream_outbound_audio", {
    callSid: callSid?.slice(0, 8),
    streamSid: streamSid.slice(0, 8),
    mulawBytes: telephonyMulaw.length,
    base64Length: payload.length,
  });

  send({
    event: "media",
    streamSid,
    media: {
      track: "outbound",
      payload,
    },
  });

  if (callSid) {
    touchOutboundAudio(callSid);
  }
}

/** Send μ-law comfort noise to keep the Media Stream socket alive. */
export function sendComfortNoise(
  send: MediaStreamSendFn,
  streamSid: string,
  callSid?: string,
  byteLength = MIN_AUDIO_CHUNK_BYTES,
): void {
  sendAudio(send, streamSid, buildComfortNoisePacket(byteLength), callSid);
}

/** Stream synthesized μ-law audio frames to Twilio Media Streams. */
export async function streamSpeechToMediaStream(
  text: string,
  send: MediaStreamSendFn,
  options: StreamAudioOptions,
  callSid?: string,
): Promise<void> {
  const trimmed = sanitizeTextForTTS(text);
  if (!trimmed || options.abortSignal?.aborted) return;

  let chunksSent = 0;

  for await (const chunk of synthesizeSpeechStream(trimmed, callSid)) {
    if (options.abortSignal?.aborted) break;

    const frames = telephonyFramesFromChunk(chunk.audio);

    for (const frame of frames) {
      if (options.abortSignal?.aborted) break;
      sendAudio(send, options.streamSid, frame, callSid, chunk.sourceFormat);
      options.onAudioSent?.();
      chunksSent++;
    }
  }

  if (chunksSent === 0) {
    logger.warn("media_stream_no_audio_generated", {
      callSid: callSid?.slice(0, 8),
      textLength: trimmed.length,
    });
  }
}

export async function streamChunkToMediaStream(
  chunk: SpeechChunk,
  send: MediaStreamSendFn,
  options: StreamAudioOptions,
  callSid?: string,
): Promise<void> {
  if (chunk.pauseMs && chunk.pauseMs > 0) {
    await sleep(chunk.pauseMs, options.abortSignal);
  }
  await streamSpeechToMediaStream(chunk.text, send, options, callSid);
}

function chunkBufferTelephony(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += MAX_AUDIO_CHUNK_BYTES) {
    frames.push(buffer.subarray(offset, offset + MAX_AUDIO_CHUNK_BYTES));
  }
  return frames;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Hard-stop outbound audio — valid Media Streams clear event (not ConversationRelay). */
export function sendMediaStreamClear(send: MediaStreamSendFn, streamSid: string): void {
  send({ event: "clear", streamSid });
}

/** Stop the media stream leg — forces Twilio to tear down buffered playback. */
export function sendMediaStreamStop(send: MediaStreamSendFn, streamSid: string): void {
  send({ event: "stop", streamSid });
}
