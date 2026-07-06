import type { WebSocket } from "ws";
import { logger } from "../utils/logger.js";
import { pipelineTrace } from "../utils/pipelineTrace.js";
import {
  createCallSession,
  endCallSession,
  process,
} from "../agents/conversationOrchestrator.js";
import {
  bufferPartialTranscript,
  clearStreamBarrier,
  enqueueStreamTurn,
  takeFinalTranscript,
} from "../runtime/streamTurnBarrier.js";
import {
  clearDictationLock,
  enterDictationLock,
  isDictationLocked,
} from "../runtime/dictationLock.js";
import { logEventIngestion } from "../runtime/turnObservability.js";
import { logTtsEngineSelection, getElevenLabsVoiceSettings } from "../adapters/ttsAdapter.js";
import { clearShoppingCart } from "../agents/cartManager.js";
import { streamOneChunkToRelay, finalizeRelayStream } from "../services/voiceService.js";
import { conversationRelayVoice } from "../config.js";
import { isNoiseTranscript } from "../utils/noiseGate.js";
import {
  isCallSessionActive,
  markCallSessionClosed,
} from "./callSessionLock.js";
import type { CallSession, TwilioRelayInboundMessage } from "../types/order.js";

const RELAY_ERROR_SPEECH =
  "Sorry, we're having a brief technical issue. Please try again in a moment.";

type SendFn = (msg: {
  type: "text" | "end";
  token?: string;
  last?: boolean;
  interruptible?: boolean;
  handoffData?: string;
}) => Promise<void>;

export async function handleConversationRelaySocket(socket: WebSocket): Promise<void> {
  let session: CallSession | null = null;
  let turnAbort: AbortController | null = null;
  let closed = false;

  const send: SendFn = async (msg) => {
    if (closed) return;
    socket.send(JSON.stringify(msg));
  };

  socket.on("message", (raw) => {
    void (async () => {
      try {
        await handleRelayMessage(raw, {
          getSession: () => session,
          setSession: (s) => {
            session = s;
          },
          getTurnAbort: () => turnAbort,
          setTurnAbort: (a) => {
            turnAbort = a;
          },
          send,
          isClosed: () => closed,
        });
      } catch (err) {
        logger.error("relay_message_handler_failed", {
          callSid: session?.callSid?.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
        if (!closed) {
          await send({ type: "text", token: RELAY_ERROR_SPEECH, last: true });
        }
      }
    })();
  });

  socket.on("close", () => {
    closed = true;
    turnAbort?.abort();
    if (session?.callSid) {
      markCallSessionClosed(session.callSid);
      clearShoppingCart(session);
      clearDictationLock(session.callSid);
      clearStreamBarrier(session.callSid);
      endCallSession(session.callSid, session);
    }
    logger.info("relay_closed", { callSid: session?.callSid?.slice(0, 8) });
  });

  socket.on("error", (err) => {
    logger.error("relay_socket_error", { error: err.message });
  });
}

async function runStreamingTurn(
  session: CallSession,
  callerText: string,
  send: SendFn,
  setAbort: (controller: AbortController) => void,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed() || !isCallSessionActive(session.callSid)) {
    logger.debug("relay_turn_skipped_inactive", { callSid: session.callSid.slice(0, 8) });
    return;
  }

  const started = Date.now();
  const abort = new AbortController();
  setAbort(abort);

  let endCall = false;
  let chunkCount = 0;
  let firstChunkMs: number | null = null;

  pipelineTrace({
    layer: "streamHandler",
    file: "streamHandler.ts",
    callSid: session.callSid,
    action: "forwarding_to_orchestrator",
  });

  logTtsEngineSelection();
  logger.debug("relay_voice_profile", {
    callSid: session.callSid.slice(0, 8),
    voice: conversationRelayVoice(),
    settings: getElevenLabsVoiceSettings(),
  });

  try {
    for await (const event of process(session.callSid, callerText, session)) {
      if (abort.signal.aborted) {
        logger.debug("relay_turn_aborted", { callSid: session.callSid.slice(0, 8) });
        break;
      }

      if (event.type === "chunk") {
        if (firstChunkMs === null) {
          firstChunkMs = Date.now() - started;
        }
        if (event.chunk.kind === "dictation") {
          enterDictationLock(session.callSid);
        }
        await streamOneChunkToRelay(event.chunk, send, false, { abortSignal: abort.signal });
        chunkCount++;
      }

      if (event.type === "done") {
        endCall = event.endCall ?? false;
        if (!abort.signal.aborted) {
          await finalizeRelayStream(send);
        }
        clearDictationLock(session.callSid);
        logger.info("relay_turn_complete", {
          callSid: session.callSid.slice(0, 8),
          phase: event.phase,
          elapsedMs: Date.now() - started,
          firstChunkMs,
          lookupMs: event.lookupMs,
          chunks: chunkCount,
        });
      }
    }
  } catch (err) {
    logger.error("relay_turn_error", {
      callSid: session.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    if (!abort.signal.aborted) {
      await send({ type: "text", token: RELAY_ERROR_SPEECH, last: false });
      await finalizeRelayStream(send);
    }
  }

  if (endCall && !abort.signal.aborted) {
    await send({ type: "end", handoffData: JSON.stringify({ reason: "caller_done" }) });
  }
}

function scheduleStreamingTurn(
  session: CallSession,
  callerText: string,
  ctx: RelayMessageContext,
): Promise<void> {
  if (ctx.isClosed() || !isCallSessionActive(session.callSid)) {
    return Promise.resolve();
  }

  if (isNoiseTranscript(callerText, { allowShortNumeric: true })) {
    logger.debug("noise_gate_dropped_relay", {
      callSid: session.callSid.slice(0, 8),
      textLength: callerText.length,
      preview: callerText.slice(0, 12),
    });
    return Promise.resolve();
  }

  return enqueueStreamTurn(session.callSid, () =>
    runStreamingTurn(session, callerText, ctx.send, (controller) => {
      ctx.setTurnAbort(controller);
    }, ctx.isClosed),
  );
}

interface RelayMessageContext {
  getSession: () => CallSession | null;
  setSession: (session: CallSession) => void;
  getTurnAbort: () => AbortController | null;
  setTurnAbort: (abort: AbortController | null) => void;
  send: SendFn;
  isClosed: () => boolean;
}

/** Apply Twilio barge-in — suppressed while tracking dictation lock is held. */
export function applyRelayInterrupt(ctx: Pick<RelayMessageContext, "getSession" | "getTurnAbort">): {
  action: "suppressed" | "aborted" | "ignored";
} {
  const callSid = ctx.getSession()?.callSid;
  if (callSid && isDictationLocked(callSid)) {
    logger.debug("relay_interrupt_suppressed_dictation", {
      callSid: callSid.slice(0, 8),
    });
    return { action: "suppressed" };
  }

  const abort = ctx.getTurnAbort();
  if (!abort) {
    logger.debug("relay_interrupt", { callSid: callSid?.slice(0, 8) });
    return { action: "ignored" };
  }

  logger.debug("relay_interrupt", { callSid: callSid?.slice(0, 8) });
  abort.abort();
  return { action: "aborted" };
}

async function handleRelayMessage(raw: WebSocket.RawData, ctx: RelayMessageContext): Promise<void> {
  let message: TwilioRelayInboundMessage;
  try {
    message = JSON.parse(raw.toString()) as TwilioRelayInboundMessage;
  } catch {
    logger.warn("relay_invalid_json");
    return;
  }

  switch (message.type) {
    case "setup": {
      const from = message.from ?? message.customParameters?.from ?? "unknown";
      const to = message.to ?? message.customParameters?.to ?? "unknown";
      const session = createCallSession(message.callSid ?? "unknown", from, to);
      session.callerPhone = from;
      ctx.setSession(session);
      logger.info("relay_setup", { callSid: session.callSid.slice(0, 8) });

      const routerSpeech = (message.customParameters?.routerSpeech ?? "").trim();
      if (routerSpeech) {
        logEventIngestion(session.callSid, {
          source: "router_speech",
          textLength: routerSpeech.length,
          partial: false,
        });
        await scheduleStreamingTurn(session, routerSpeech, ctx);
      }
      break;
    }

    case "prompt": {
      const session = ctx.getSession();
      if (!session || ctx.isClosed()) return;

      if (!message.last) {
        bufferPartialTranscript(session.callSid, message.voicePrompt ?? "");
        logEventIngestion(session.callSid, {
          source: "prompt",
          textLength: (message.voicePrompt ?? "").length,
          partial: true,
        });
        return;
      }

      const callerText = takeFinalTranscript(session.callSid, message.voicePrompt ?? "");
      if (!callerText) return;

      logEventIngestion(session.callSid, {
        source: "prompt",
        textLength: callerText.length,
        partial: false,
      });

      await scheduleStreamingTurn(session, callerText, ctx);
      break;
    }

    case "interrupt": {
      applyRelayInterrupt(ctx);
      break;
    }

    case "dtmf": {
      const session = ctx.getSession();
      if (!session || !message.digit || ctx.isClosed()) return;
      logEventIngestion(session.callSid, {
        source: "dtmf",
        textLength: message.digit.length,
        partial: false,
      });
      await scheduleStreamingTurn(session, message.digit, ctx);
      break;
    }

    case "error":
      logger.error("relay_error", { description: message.description });
      break;

    default:
      logger.debug("relay_unknown_type", { type: (message as { type?: string }).type });
  }
}
