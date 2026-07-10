/**
 * ConversationRelay outbound text — Twilio synthesizes Eric voice from VOICE_ID.
 */
import { logger } from "../utils/logger.js";
import { splitIntoSmoothedChunks } from "../services/voiceSmoothingEngine.js";
import type { TwilioRelayOutboundMessage } from "../types/order.js";

export type ConversationRelaySendFn = (msg: TwilioRelayOutboundMessage) => void;

export interface SendSpeechOptions {
  interruptible?: boolean;
  preemptible?: boolean;
  preserveFull?: boolean;
  interrupted?: () => boolean;
  /**
   * When false (default), tokens use last:false so the turn can keep streaming.
   * The handler finalizes with an empty last:true after the turn.
   */
  endOfTurn?: boolean;
}

export function buildTextPayload(
  token: string,
  last: boolean,
  interruptible = true,
  preemptible = true,
): TwilioRelayOutboundMessage {
  return { type: "text", token, last, interruptible, preemptible };
}

/** Stop in-flight TTS by preempting with an empty final token. */
export function flushConversationRelaySpeech(send: ConversationRelaySendFn): void {
  send(buildTextPayload("", true, true, true));
}

/** Stream agent speech as ConversationRelay text tokens (sentence / phrase chunks). */
export async function sendSpeechToConversationRelay(
  send: ConversationRelaySendFn,
  text: string,
  options?: SendSpeechOptions,
): Promise<boolean> {
  const trimmed = (text ?? "").trim();
  const interruptible = options?.interruptible ?? true;
  const preemptible = options?.preemptible ?? true;
  const endOfTurn = options?.endOfTurn ?? false;

  if (!trimmed) {
    if (endOfTurn) {
      send(buildTextPayload("", true, interruptible, preemptible));
    }
    return false;
  }

  const chunks = splitIntoSmoothedChunks(trimmed, {
    preserveFull: options?.preserveFull,
  })
    .map((c) => c.text)
    .filter(Boolean);

  if (!chunks.length) {
    if (endOfTurn) {
      send(buildTextPayload("", true, interruptible, preemptible));
    }
    return false;
  }

  for (let i = 0; i < chunks.length; i++) {
    if (options?.interrupted?.()) {
      logger.debug("conversation_relay_send_cancelled", { reason: "interrupt" });
      return false;
    }
    const isLast = endOfTurn && i === chunks.length - 1;
    send(buildTextPayload(chunks[i], isLast, interruptible, preemptible));
  }

  return true;
}

export function sendEndCall(send: ConversationRelaySendFn): void {
  send({
    type: "end",
    handoffData: JSON.stringify({ reason: "caller_done" }),
  });
}
