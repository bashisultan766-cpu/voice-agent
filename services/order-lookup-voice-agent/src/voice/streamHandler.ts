import type { WebSocket } from "ws";
import { logger } from "../utils/logger.js";
import { createCallSession, streamAgentTurn } from "../agents/orderAgent.js";
import { clearCallMemory } from "../memory/callMemoryStore.js";
import { streamOneChunkToRelay, finalizeRelayStream } from "../services/voiceService.js";
import type { CallSession, TwilioRelayInboundMessage } from "../types/order.js";

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
      let message: TwilioRelayInboundMessage;
      try {
        message = JSON.parse(raw.toString()) as TwilioRelayInboundMessage;
      } catch {
        logger.warn("relay_invalid_json");
        return;
      }

      switch (message.type) {
        case "setup":
          session = createCallSession(
            message.callSid ?? "unknown",
            message.from ?? message.customParameters?.from ?? "unknown",
            message.to ?? message.customParameters?.to ?? "unknown",
          );
          session.phase = "awaiting_order_number";
          logger.info("relay_setup", { callSid: session.callSid.slice(0, 8) });

          const routerSpeech = (message.customParameters?.routerSpeech ?? "").trim();
          if (routerSpeech) {
            currentTurn = runStreamingTurn(session, routerSpeech, send, () => turnAbort);
            await currentTurn;
            currentTurn = null;
          }
          break;

        case "prompt":
          if (!session) return;
          // Only act on final STT — ignore partial transcripts (caller mid-sentence pause).
          if (!message.last) return;

          turnAbort?.abort();
          currentTurn = runStreamingTurn(session, message.voicePrompt ?? "", send, (controller) => {
            turnAbort = controller;
          });
          await currentTurn;
          currentTurn = null;
          break;

        case "interrupt":
          logger.debug("relay_interrupt", { callSid: session?.callSid?.slice(0, 8) });
          turnAbort?.abort();
          break;

        case "dtmf":
          if (!session || !message.digit) return;
          turnAbort?.abort();
          currentTurn = runStreamingTurn(session, message.digit, send, (controller) => {
            turnAbort = controller;
          });
          await currentTurn;
          currentTurn = null;
          break;

        case "error":
          logger.error("relay_error", { description: message.description });
          break;

        default:
          logger.debug("relay_unknown_type", { type: (message as { type?: string }).type });
      }
    })();
  });

  socket.on("close", () => {
    closed = true;
    turnAbort?.abort();
    if (session?.callSid) {
      clearCallMemory(session.callSid);
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

  try {
    for await (const event of streamAgentTurn(session, callerText)) {
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
      await finalizeRelayStream(send);
    }
  }

  if (endCall && !abort.signal.aborted) {
    await send({ type: "end", handoffData: JSON.stringify({ reason: "caller_done" }) });
    session.phase = "ended";
  }
}
