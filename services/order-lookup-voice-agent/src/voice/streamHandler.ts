import type { WebSocket } from "ws";
import { logger } from "../utils/logger.js";
import {
  createCallSession,
  endCallSession,
  process,
} from "../agents/conversationOrchestrator.js";
import { streamOneChunkToRelay, finalizeRelayStream } from "../services/voiceService.js";
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
  let currentTurn: Promise<void> | null = null;
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
          getCurrentTurn: () => currentTurn,
          setCurrentTurn: (t) => {
            currentTurn = t;
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
      endCallSession(session.callSid);
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
): Promise<void> {
  const started = Date.now();
  const abort = new AbortController();
  setAbort(abort);

  let endCall = false;
  let chunkCount = 0;
  let firstChunkMs: number | null = null;

  console.log({
    stage: "streamHandler",
    action: "forwarding_to_orchestrator",
    callSid: session.callSid.slice(0, 8),
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
        await streamOneChunkToRelay(event.chunk, send, false, { abortSignal: abort.signal });
        chunkCount++;
      }

      if (event.type === "done") {
        endCall = event.endCall ?? false;
        if (!abort.signal.aborted) {
          await finalizeRelayStream(send);
        }
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

interface RelayMessageContext {
  getSession: () => CallSession | null;
  setSession: (session: CallSession) => void;
  getCurrentTurn: () => Promise<void> | null;
  setCurrentTurn: (turn: Promise<void> | null) => void;
  getTurnAbort: () => AbortController | null;
  setTurnAbort: (abort: AbortController | null) => void;
  send: SendFn;
  isClosed: () => boolean;
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
      const session = createCallSession(
        message.callSid ?? "unknown",
        message.from ?? message.customParameters?.from ?? "unknown",
        message.to ?? message.customParameters?.to ?? "unknown",
      );
      ctx.setSession(session);
      logger.info("relay_setup", { callSid: session.callSid.slice(0, 8) });

      const routerSpeech = (message.customParameters?.routerSpeech ?? "").trim();
      if (routerSpeech) {
        const turn = runStreamingTurn(session, routerSpeech, ctx.send, () => ctx.getTurnAbort());
        ctx.setCurrentTurn(turn);
        await turn;
        ctx.setCurrentTurn(null);
      }
      break;
    }

    case "prompt": {
      const session = ctx.getSession();
      if (!session) return;
      if (!message.last) return;

      ctx.getTurnAbort()?.abort();
      const turn = runStreamingTurn(session, message.voicePrompt ?? "", ctx.send, (controller) => {
        ctx.setTurnAbort(controller);
      });
      ctx.setCurrentTurn(turn);
      await turn;
      ctx.setCurrentTurn(null);
      break;
    }

    case "interrupt":
      logger.debug("relay_interrupt", { callSid: ctx.getSession()?.callSid?.slice(0, 8) });
      ctx.getTurnAbort()?.abort();
      break;

    case "dtmf": {
      const session = ctx.getSession();
      if (!session || !message.digit) return;
      ctx.getTurnAbort()?.abort();
      const turn = runStreamingTurn(session, message.digit, ctx.send, (controller) => {
        ctx.setTurnAbort(controller);
      });
      ctx.setCurrentTurn(turn);
      await turn;
      ctx.setCurrentTurn(null);
      break;
    }

    case "error":
      logger.error("relay_error", { description: message.description });
      break;

    default:
      logger.debug("relay_unknown_type", { type: (message as { type?: string }).type });
  }
}
