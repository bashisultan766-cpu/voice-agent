/**
 * ConversationRelay outbound text — Twilio synthesizes Eric voice from VOICE_ID.
 */
import { logger } from "../utils/logger.js";
import { splitIntoSmoothedChunks } from "../services/voiceSmoothingEngine.js";
import type { TwilioRelayOutboundMessage } from "../types/order.js";

export type ConversationRelaySendFn = (msg: TwilioRelayOutboundMessage) => void;

export interface SendSpeechOptions {
  interruptible?: boolean;
  preserveFull?: boolean;
  interrupted?: () => boolean;
}

export function buildTextPayload(
  token: string,
  last: boolean,
  interruptible = true,
): TwilioRelayOutboundMessage {
  return { type: "text", token, last, interruptible };
}

/** Stream agent speech as ConversationRelay text tokens (8–14 word chunks). */
export async function sendSpeechToConversationRelay(
  send: ConversationRelaySendFn,
  text: string,
  options?: SendSpeechOptions,
): Promise<boolean> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    send(buildTextPayload("", true));
    return false;
  }

  const chunks = splitIntoSmoothedChunks(trimmed, {
    preserveFull: options?.preserveFull,
  }).map((c) => c.text).filter(Boolean);

  if (!chunks.length) {
    send(buildTextPayload("", true));
    return false;
  }

  for (let i = 0; i < chunks.length; i++) {
    if (options?.interrupted?.()) {
      logger.debug("conversation_relay_send_cancelled", { reason: "interrupt" });
      return false;
    }
    const isLast = i === chunks.length - 1;
    send(
      buildTextPayload(
        chunks[i],
        isLast,
        options?.interruptible ?? true,
      ),
    );
  }

  return true;
}

export function sendEndCall(send: ConversationRelaySendFn): void {
  send({
    type: "end",
    handoffData: JSON.stringify({ reason: "caller_done" }),
  });
}
