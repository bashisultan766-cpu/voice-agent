/**
 * Twilio ConversationRelay WebSocket — text tokens in, Eric voice out (Twilio-side TTS).
 * Business logic: conversationOrchestrator.runOrchestratorTurn → process → llmOrchestrator.
 */
import type { WebSocket } from "ws";

import {
  createOrHydrateCallSession,
  endCallSession,
  runOrchestratorTurn,
} from "../agents/conversationOrchestrator.js";
import { enqueueStreamTurn } from "../runtime/streamTurnBarrier.js";
import {
  abortActiveTurn,
  beginTurnAbort,
  clearTurnAbort,
} from "../runtime/turnAbortRegistry.js";
import { logger } from "../utils/logger.js";
import { isNoiseTranscript } from "../utils/noiseGate.js";
import {
  isCallSessionActive,
  markCallSessionClosed,
} from "./callSessionLock.js";
import type { CallSession, TwilioRelayInboundMessage } from "../types/order.js";
import {
  flushConversationRelaySpeech,
  sendEndCall,
  sendSpeechToConversationRelay,
  type ConversationRelaySendFn,
} from "./conversationRelaySender.js";

import { VOICE_LAYER_ERROR_SPEECH } from "../constants/systemMessages.js";

const interruptedCalls = new Set<string>();

function setInterrupted(callSid: string, value: boolean): void {
  if (value) interruptedCalls.add(callSid);
  else interruptedCalls.delete(callSid);
}

function isInterrupted(callSid: string): boolean {
  return interruptedCalls.has(callSid);
}

/** Halt generation + flush TTS; keep UnifiedCallSession intact. */
function handleBargeIn(callSid: string, send: ConversationRelaySendFn, reason: string): void {
  logger.info("conversation_relay_barge_in", {
    callSid: callSid.slice(0, 8),
    reason,
  });
  setInterrupted(callSid, true);
  abortActiveTurn(callSid);
  try {
    flushConversationRelaySpeech(send);
  } catch (err) {
    logger.warn("conversation_relay_flush_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runRelayTurn(
  session: CallSession,
  callerText: string,
  send: ConversationRelaySendFn,
): Promise<void> {
  const callSid = session.callSid;
  setInterrupted(callSid, false);

  const controller = beginTurnAbort(callSid);

  let endCall = false;

  try {
    for await (const event of runOrchestratorTurn(session, callerText)) {
      if (controller.signal.aborted || isInterrupted(callSid)) {
        break;
      }
      if (event.type === "chunk" && event.chunk.text?.trim()) {
        await sendSpeechToConversationRelay(send, event.chunk.text, {
          preserveFull: event.chunk.preserveFull,
          endOfTurn: false,
          interrupted: () => controller.signal.aborted || isInterrupted(callSid),
        });
      }
      if (event.type === "done") {
        endCall = Boolean(event.endCall);
      }
    }

    if (!controller.signal.aborted && !isInterrupted(callSid)) {
      send({
        type: "text",
        token: "",
        last: true,
        interruptible: true,
        preemptible: true,
      });
    }

    if (endCall && !isInterrupted(callSid)) {
      sendEndCall(send);
    }
  } catch (err) {
    logger.error("conversation_relay_turn_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    if (!isInterrupted(callSid)) {
      await sendSpeechToConversationRelay(send, VOICE_LAYER_ERROR_SPEECH, {
        endOfTurn: true,
      });
    }
  } finally {
    clearTurnAbort(callSid);
  }
}

export async function handleConversationRelaySocket(socket: WebSocket): Promise<void> {
  let session: CallSession | null = null;
  let closed = false;

  const send: ConversationRelaySendFn = (msg) => {
    if (closed) return;
    socket.send(JSON.stringify(msg));
  };

  socket.on("message", (raw) => {
    void (async () => {
      let message: TwilioRelayInboundMessage;
      try {
        message = JSON.parse(raw.toString()) as TwilioRelayInboundMessage;
      } catch {
        logger.warn("conversation_relay_non_json_frame");
        return;
      }

      const type = message.type;

      if (type === "setup") {
        const custom = message.customParameters ?? {};
        const callSid = String(message.callSid ?? custom.callSid ?? "").trim();
        const from = String(message.from ?? custom.from ?? "unknown");
        const to = String(message.to ?? custom.to ?? "unknown");

        if (!callSid) {
          logger.error("conversation_relay_setup_missing_call_sid");
          return;
        }

        session = await createOrHydrateCallSession(callSid, from, to);
        session.greetedThisCall = true;
        logger.info("conversation_relay_setup", {
          callSid: callSid.slice(0, 8),
          from: from.slice(-4),
          to: to.slice(-4),
          hydrated: Boolean(session.persistenceVersion && session.persistenceVersion > 1),
        });
        return;
      }

      if (!session) {
        logger.warn("conversation_relay_message_before_setup", { type });
        return;
      }

      const callSid = session.callSid;

      if (type === "prompt") {
        if (message.last === false) return;

        const voicePrompt = (message.voicePrompt ?? "").trim();
        if (!voicePrompt || isNoiseTranscript(voicePrompt)) return;

        if (!isCallSessionActive(callSid)) return;

        logger.info("conversation_relay_prompt", {
          callSid: callSid.slice(0, 8),
          chars: voicePrompt.length,
        });

        await enqueueStreamTurn(callSid, () =>
          runRelayTurn(session!, voicePrompt, send),
        );
        return;
      }

      if (type === "interrupt") {
        handleBargeIn(callSid, send, "interrupt");
        return;
      }

      if (type === "dtmf") {
        // DTMF barge-in: halt TTS / generation; session state is preserved.
        handleBargeIn(callSid, send, `dtmf:${message.digit ?? "?"}`);
        return;
      }

      if (type === "error") {
        logger.warn("conversation_relay_twilio_error", {
          callSid: callSid.slice(0, 8),
          description: message.description,
        });
      }
    })().catch((err) => {
      logger.error("conversation_relay_message_handler_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  socket.on("close", () => {
    closed = true;
    if (session) {
      abortActiveTurn(session.callSid);
      setInterrupted(session.callSid, false);
      endCallSession(session.callSid, session);
      markCallSessionClosed(session.callSid);
    }
  });

  socket.on("error", (err) => {
    logger.error("conversation_relay_socket_error", { error: err.message });
  });
}
