import type { SpeechChunk } from "../types/order.js";
import { synthesizeSpeechStream } from "../adapters/ttsAdapter.js";
import { sanitizeTextForTTS } from "../utils/ttsFormatter.js";
import type { MediaStreamOutboundMessage } from "../voice/mediaStreamProtocol.js";

export type MediaStreamSendFn = (msg: MediaStreamOutboundMessage) => void;

export interface StreamAudioOptions {
  abortSignal?: AbortSignal;
  streamSid: string;
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

  for await (const chunk of synthesizeSpeechStream(trimmed, callSid)) {
    if (options.abortSignal?.aborted) break;
    send({
      event: "media",
      streamSid: options.streamSid,
      media: { payload: chunk.audio.toString("base64") },
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
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
