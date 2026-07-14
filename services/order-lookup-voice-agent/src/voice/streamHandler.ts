import type { WebSocket } from "ws";

import { logger } from "../utils/logger.js";
import { pipelineTrace } from "../utils/pipelineTrace.js";
import {
  createOrHydrateCallSession,
  endCallSession,
  process,
  USER_INTERRUPTED_DICTATION_SIGNAL,
} from "../agents/conversationOrchestrator.js";
import { enqueueStreamTurn } from "../runtime/streamTurnBarrier.js";
import { clearDictationLock, enterDictationLock } from "../runtime/dictationLock.js";
import {
  clearInterruptBuffer,
  isInterruptBufferFull,
  pushInterruptSignal,
  takeInterruptSignal,
} from "../runtime/interruptBuffer.js";
import { logEventIngestion } from "../runtime/turnObservability.js";
import {
  flushUnifiedSessionToL2,
  touchUnifiedSession,
} from "../agents/unifiedCallSession.js";
import {
  clearOutboundAudioTracking,
  getLastOutboundAudioAt,
  sendComfortNoise,
  sendMediaStreamClear,
  sendMediaStreamStop,
  sendAudio,
  streamChunkToMediaStream,
  streamSpeechToMediaStream,
  touchOutboundAudio,
  type MediaStreamSendFn,
} from "../services/mediaStreamVoice.js";
import {
  chunkEndIndex,
  setLastSpokenIndex,
  TRACKING_DICTATION_CHUNK_SIZE,
} from "../agents/dictationTool.js";
import {
  getOrCreateActiveSession,
  setAgentRelayState,
} from "../sovereign/activeSession.js";
import { isNoiseTranscript } from "../utils/noiseGate.js";
import {
  isCallSessionActive,
  markCallSessionClosed,
} from "./callSessionLock.js";
import { transcribeMulawBuffer } from "./mediaStreamStt.js";
import type {
  MediaStreamInboundMessage,
  MediaStreamStartMessage,
} from "./mediaStreamProtocol.js";
import { TWILIO_MEDIA_STREAM_PROTOCOL } from "./mediaStreamProtocol.js";
import type { CallSession } from "../types/order.js";

import { VOICE_LAYER_ERROR_SPEECH } from "../constants/systemMessages.js";
import {
  BARGE_IN_HOLD_MS,
  evaluateBargeIn,
  estimateMulawPower,
  VAD_SILENCE_THRESHOLD_MS,
  VERIFICATION_SILENCE_PROMPT_MS,
} from "../streaming/audioProcessor.js";
import {
  processVoicePreTurn,
  silenceWaitMsForSession,
} from "./voicePreTurn.js";
import {
  SharedListeningWaitScheduler,
  cancelListeningWaitTimer,
} from "./turnScheduler.js";
import { TerminationCoordinator } from "../runtime/terminationCoordinator.js";

/** VAD endpointing — full second of silence before turn-end (calm pacing). */
const SILENCE_MS = VAD_SILENCE_THRESHOLD_MS;
const MIN_INBOUND_MULAW_BYTES = 3200;
const STREAM_HEARTBEAT_IDLE_MS = 500;
const STREAM_HEARTBEAT_TICK_MS = 100;

const speakingTurns = new Set<string>();
const activeTurnAborts = new Map<string, AbortController>();
const streamSendRegistry = new Map<string, MediaStreamSendFn>();
const streamSidRegistry = new Map<string, string>();
const inboundMulawBuffers = new Map<string, Buffer[]>();
const silenceTimers = new Map<string, NodeJS.Timeout>();
const heartbeatTimers = new Map<string, NodeJS.Timeout>();
/** Rolling outbound power for barge-in comparison. */
const outboundPowerByCall = new Map<string, number>();
/** Sustained loud inbound ms while agent is speaking. */
const bargeInHoldMsByCall = new Map<string, number>();
/** Last inbound media timestamp (for hold accumulation). */
const lastInboundAtByCall = new Map<string, number>();

type TurnGenerator = (
  callSid: string,
  callerText: string,
  session: CallSession,
) => AsyncGenerator<import("../types/order.js").AgentStreamEvent>;

function flushInboundBuffer(callSid: string): Buffer {
  const chunks = inboundMulawBuffers.get(callSid) ?? [];
  inboundMulawBuffers.set(callSid, []);
  return Buffer.concat(chunks);
}

function registerStreamSend(callSid: string, send: MediaStreamSendFn, streamSid: string): void {
  streamSendRegistry.set(callSid, send);
  streamSidRegistry.set(callSid, streamSid);
}

/** Cancel VAD silence endpointing timers for a call — idempotent. */
function cancelVadSilenceTimers(callSid: string): void {
  const timer = silenceTimers.get(callSid);
  if (timer) clearTimeout(timer);
  silenceTimers.delete(callSid);
}

function unregisterStreamSend(callSid: string): void {
  streamSendRegistry.delete(callSid);
  streamSidRegistry.delete(callSid);
  inboundMulawBuffers.delete(callSid);
  outboundPowerByCall.delete(callSid);
  bargeInHoldMsByCall.delete(callSid);
  lastInboundAtByCall.delete(callSid);
  cancelVadSilenceTimers(callSid);
  cancelListeningWaitTimer(callSid);
  SharedListeningWaitScheduler.unregisterDelivery(callSid);
  stopStreamHeartbeat(callSid);
  clearOutboundAudioTracking(callSid);
}

function startStreamHeartbeat(callSid: string): void {
  stopStreamHeartbeat(callSid);
  touchOutboundAudio(callSid);

  heartbeatTimers.set(
    callSid,
    setInterval(() => {
      const send = streamSendRegistry.get(callSid);
      const streamSid = streamSidRegistry.get(callSid);
      if (!send || !streamSid) return;

      const idleMs = Date.now() - getLastOutboundAudioAt(callSid);
      if (idleMs >= STREAM_HEARTBEAT_IDLE_MS) {
        sendComfortNoise(send, streamSid, callSid);
      }
    }, STREAM_HEARTBEAT_TICK_MS),
  );
}

function stopStreamHeartbeat(callSid: string): void {
  const timer = heartbeatTimers.get(callSid);
  if (timer) clearInterval(timer);
  heartbeatTimers.delete(callSid);
}

/** @deprecated Use sendAudio from mediaStreamVoice — re-exported for pipeline diagnostics. */
export { sendAudio };

/** Hard-stop — clear buffer, abort TTS, optional stream stop/reopen via Twilio Media Streams. */
export async function abortCurrentTTS(callSid: string, reopenStream = false): Promise<boolean> {
  const abort = activeTurnAborts.get(callSid);
  const wasSpeaking = Boolean(abort && !abort.signal.aborted) || speakingTurns.has(callSid);

  if (abort && !abort.signal.aborted) {
    abort.abort();
  }

  speakingTurns.delete(callSid);
  clearDictationLock(callSid);
  setAgentRelayState(callSid, "LISTENING");

  const send = streamSendRegistry.get(callSid);
  const streamSid = streamSidRegistry.get(callSid);
  if (send && streamSid) {
    sendMediaStreamClear(send, streamSid);
    if (reopenStream) {
      sendMediaStreamStop(send, streamSid);
    }
  }

  if (wasSpeaking) {
    logger.debug("media_stream_tts_aborted", { callSid: callSid.slice(0, 8) });
  }

  return wasSpeaking;
}

export async function handleMediaStreamSocket(socket: WebSocket): Promise<void> {
  let session: CallSession | null = null;
  let turnAbort: AbortController | null = null;
  let closed = false;
  /** Guards double-close so L2 flush / endCallSession run at most once. */
  let teardownStarted = false;
  let streamSid = "";
  let callSid = "";

  const send: MediaStreamSendFn = (msg) => {
    if (closed) return;
    if (msg.event === "media" && msg.media?.payload) {
      console.log("SENDING_AUDIO_CHUNK_TO_TWILIO", {
        callSid: callSid ? callSid.slice(0, 8) : undefined,
        streamSid: msg.streamSid.slice(0, 8),
        base64Length: msg.media.payload.length,
        track: msg.media.track ?? "outbound",
      });
    }
    socket.send(JSON.stringify(msg));
  };

  /**
   * Cart-survival teardown: persist shopping cart + wait buffer to L2 before
   * endCallSession. Never clears the cart on socket close (transient blips).
   */
  const teardownMediaStreamSession = async (): Promise<void> => {
    if (teardownStarted) return;
    teardownStarted = true;
    closed = true;
    turnAbort?.abort();

    const activeCallSid = callSid;
    const activeSession = session;

    if (activeCallSid) {
      // (a) Cancel any active LISTENING_WAIT / VAD silence timers.
      cancelVadSilenceTimers(activeCallSid);
      cancelListeningWaitTimer(activeCallSid);
      speakingTurns.delete(activeCallSid);
      activeTurnAborts.delete(activeCallSid);
      clearInterruptBuffer(activeCallSid);
      unregisterStreamSend(activeCallSid);
      markCallSessionClosed(activeCallSid);
    }

    if (activeSession && activeCallSid) {
      const cartItemsCount = activeSession.shoppingCart?.length ?? 0;

      // (b) Capture latest cart / wait-buffer state into L1.
      touchUnifiedSession(activeSession);

      // (c) Force L2 flush before endCallSession so cart survives reconnect.
      let persistState: "persisted" | "persist_failed" = "persisted";
      try {
        const flushResult = await flushUnifiedSessionToL2(activeSession, {
          force: true,
        });
        if (!flushResult.ok) {
          persistState = "persist_failed";
          logger.error("session_teardown_flush_critical", {
            callSid: activeCallSid.slice(0, 8),
            reason: flushResult.reason,
            cartItemsCount,
          });
        }
      } catch (err) {
        persistState = "persist_failed";
        logger.error("session_teardown_flush_critical", {
          callSid: activeCallSid.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
          cartItemsCount,
        });
      }

      logger.info(
        `[SessionTeardown] callSid=${activeCallSid} reason="socket_close" cartItemsCount=${cartItemsCount} state="${persistState}"`,
        {
          callSid: activeCallSid.slice(0, 8),
          reason: "socket_close",
          cartItemsCount,
          state: persistState,
        },
      );

      // Persist (or best-effort) completed — then tear down in-memory session.
      // endCallSession saves cart via callerMemory; cart must still be intact.
      clearDictationLock(activeCallSid);
      endCallSession(activeCallSid, activeSession);
    }

    logger.info("media_stream_closed", {
      callSid: activeCallSid ? activeCallSid.slice(0, 8) : undefined,
    });
  };

  const scheduleTurn = (callerText: string): Promise<void> => {
    const activeSession = session;
    if (!activeSession) return Promise.resolve();
    return enqueueStreamTurn(activeSession.callSid, () =>
      runStreamingTurn(activeSession, callerText, send, streamSid, (controller) => {
        turnAbort = controller;
      }),
    );
  };

  const scheduleSilenceTranscription = (): void => {
    if (!callSid || !session) return;
    const existing = silenceTimers.get(callSid);
    if (existing) clearTimeout(existing);

    // Shared pre-turn silence wait (parity with ConversationRelay).
    const waitMs = silenceWaitMsForSession(session);

    silenceTimers.set(
      callSid,
      setTimeout(() => {
        void flushAndTranscribe();
      }, waitMs),
    );
  };

  const flushAndTranscribe = async (): Promise<void> => {
    if (!session || !callSid || closed) return;
    const mulaw = flushInboundBuffer(callSid);
    if (mulaw.length < MIN_INBOUND_MULAW_BYTES) return;

    if (speakingTurns.has(callSid)) {
      await onUserSpeechDetected(callSid, mulaw);
      return;
    }

    const transcript = await transcribeMulawBuffer(mulaw);
    if (!transcript || isNoiseTranscript(transcript)) return;

    const preTurn = processVoicePreTurn(session, {
      transport: "media_streams",
      callId: callSid,
      text: transcript,
    });

    if (preTurn.action === "listening_wait") {
      if (preTurn.speech) {
        await streamSpeechToMediaStream(preTurn.speech, send, {
          streamSid,
          onAudioSent: () => touchOutboundAudio(callSid),
        }, callSid);
      }
      SharedListeningWaitScheduler.arm(session, preTurn.waitId, {
        isSessionActive: () => !closed && isCallSessionActive(callSid),
        onInterjection: async (decision) => {
          if (closed || !decision.speech) return;
          await streamSpeechToMediaStream(decision.speech, send, {
            streamSid,
            onAudioSent: () => touchOutboundAudio(callSid),
          }, callSid);
        },
      });
      return;
    }

    if (preTurn.action === "listening_wait_timeout") {
      // Legacy path — buffer-preserving interjections use listening_wait instead.
      if (preTurn.speech) {
        await streamSpeechToMediaStream(preTurn.speech, send, {
          streamSid,
          onAudioSent: () => touchOutboundAudio(callSid),
        }, callSid);
      }
      return;
    }

    logEventIngestion(callSid, {
      source: "media_stream",
      textLength: preTurn.text.length,
      partial: false,
    });

    await scheduleTurn(preTurn.text);
  };

  socket.on("message", (raw) => {
    void (async () => {
      try {
        const message = JSON.parse(raw.toString()) as MediaStreamInboundMessage;

        if (message.event === "connected") {
          const connected = message as import("./mediaStreamProtocol.js").MediaStreamConnectedMessage;
          const protocol = connected.protocol ?? "unknown";
          if (protocol !== TWILIO_MEDIA_STREAM_PROTOCOL) {
            logger.warn("media_stream_unexpected_protocol", {
              protocol,
              expected: TWILIO_MEDIA_STREAM_PROTOCOL,
              version: connected.version,
            });
          }
          logger.info("media_stream_connected", {
            protocol,
            version: connected.version,
          });
          return;
        }

        if (message.event === "start") {
          const startMsg = message as MediaStreamStartMessage;
          streamSid = startMsg.streamSid;
          callSid = startMsg.start.callSid;
          const from = startMsg.start.customParameters?.from ?? "unknown";
          const to = startMsg.start.customParameters?.to ?? "unknown";

          session = await createOrHydrateCallSession(callSid, from, to);
          session.callerPhone = from;
          registerStreamSend(callSid, send, streamSid);
          startStreamHeartbeat(callSid);

          logger.info("media_stream_start", {
            callSid: callSid.slice(0, 8),
            streamSid: streamSid.slice(0, 8),
            hydrated: Boolean(session.persistenceVersion && session.persistenceVersion > 1),
          });

          const routerSpeech = (startMsg.start.customParameters?.routerSpeech ?? "").trim();
          const welcomeGreeting = (startMsg.start.customParameters?.welcomeGreeting ?? "").trim();

          if (routerSpeech) {
            await scheduleTurn(routerSpeech);
          } else if (welcomeGreeting) {
            session.greetedThisCall = true;
            speakingTurns.add(callSid);
            setAgentRelayState(callSid, "SPEAKING");
            await streamSpeechToMediaStream(welcomeGreeting, send, {
              streamSid,
              onAudioSent: () => {
                touchOutboundAudio(callSid);
                outboundPowerByCall.set(callSid, 2500);
              },
            }, callSid);
            speakingTurns.delete(callSid);
            setAgentRelayState(callSid, "LISTENING");
          }
          return;
        }

        if (message.event === "media" && session && callSid) {
          const mediaMsg = message as import("./mediaStreamProtocol.js").MediaStreamMediaMessage;
          if (mediaMsg.media?.track !== "inbound") return;
          const payload = Buffer.from(mediaMsg.media.payload, "base64");
          const chunks = inboundMulawBuffers.get(callSid) ?? [];
          chunks.push(payload);
          inboundMulawBuffers.set(callSid, chunks);

          // Track outbound power when we hear comfort/TTS frames via touchOutboundAudio timestamps.
          const now = Date.now();
          const prevAt = lastInboundAtByCall.get(callSid) ?? now;
          lastInboundAtByCall.set(callSid, now);

          if (speakingTurns.has(callSid)) {
            const power = estimateMulawPower(payload);
            const agentPower = outboundPowerByCall.get(callSid) ?? 0;
            const agentSilentForMs = now - getLastOutboundAudioAt(callSid);
            const decision = evaluateBargeIn({
              inboundMulaw: payload,
              agentOutboundPower: agentPower,
              agentSilentForMs,
              sustainedInboundMs: bargeInHoldMsByCall.get(callSid) ?? 0,
            });
            if (decision.inboundPower >= Math.max(agentPower, 80) * 0.9) {
              const held = (bargeInHoldMsByCall.get(callSid) ?? 0) + Math.max(0, now - prevAt);
              bargeInHoldMsByCall.set(callSid, held);
            } else {
              bargeInHoldMsByCall.set(callSid, 0);
            }
            // Only schedule silence flush for barge-in evaluation after hold builds.
            if ((bargeInHoldMsByCall.get(callSid) ?? 0) >= BARGE_IN_HOLD_MS) {
              scheduleSilenceTranscription();
            }
            return;
          }

          bargeInHoldMsByCall.set(callSid, 0);
          scheduleSilenceTranscription();
          return;
        }

        if (message.event === "stop") {
          logger.info("media_stream_stop", { callSid: callSid.slice(0, 8) });
        }
      } catch (err) {
        logger.error("media_stream_message_failed", {
          callSid: callSid.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  socket.on("close", () => {
    void teardownMediaStreamSession();
  });

  socket.on("error", (err) => {
    logger.error("media_stream_socket_error", { error: err.message });
  });
}

async function onUserSpeechDetected(callSid: string, inboundMulaw: Buffer): Promise<void> {
  if (!speakingTurns.has(callSid)) return;

  const decision = evaluateBargeIn({
    inboundMulaw,
    agentOutboundPower: outboundPowerByCall.get(callSid) ?? 0,
    agentSilentForMs: Date.now() - getLastOutboundAudioAt(callSid),
    sustainedInboundMs: bargeInHoldMsByCall.get(callSid) ?? 0,
  });

  if (!decision.allow) {
    logger.debug("barge_in_suppressed", {
      callSid: callSid.slice(0, 8),
      reason: decision.reason,
      inboundPower: Math.round(decision.inboundPower),
    });
    return;
  }

  bargeInHoldMsByCall.set(callSid, 0);
  pushInterruptSignal(callSid, "");
  const aborted = await abortCurrentTTS(callSid, true);
  if (!aborted) return;
  logger.debug("user_speech_detected_abort", { callSid: callSid.slice(0, 8) });
}

async function runStreamingTurn(
  session: CallSession,
  callerText: string,
  send: MediaStreamSendFn,
  streamSid: string,
  setAbort: (controller: AbortController) => void,
): Promise<void> {
  if (!isCallSessionActive(session.callSid)) return;

  const abort = new AbortController();
  setAbort(abort);
  activeTurnAborts.set(session.callSid, abort);
  speakingTurns.add(session.callSid);
  setAgentRelayState(session.callSid, "SPEAKING");

  let dictationIndex = -1;
  let interruptedDuringSpeech = false;
  let endCall = false;

  pipelineTrace({
    layer: "streamHandler",
    file: "streamHandler.ts",
    callSid: session.callSid,
    action: "media_stream_turn",
  });

  try {
    const generator: TurnGenerator = process;

    for await (const event of generator(session.callSid, callerText, session)) {
      if (abort.signal.aborted) {
        interruptedDuringSpeech = true;
        break;
      }

      if (event.type === "chunk") {
        logger.debug("orchestrator_chunk_received", {
          callSid: session.callSid.slice(0, 8),
          kind: event.chunk.kind,
          textLength: event.chunk.text.length,
        });

        if (isInterruptBufferFull(session.callSid)) {
          takeInterruptSignal(session.callSid);
          if (await abortCurrentTTS(session.callSid, true)) {
            interruptedDuringSpeech = true;
            break;
          }
        }

        if (event.chunk.kind === "dictation") {
          enterDictationLock(session.callSid);
          dictationIndex += 1;
          const endIndex =
            event.chunk.dictationEndIndex ??
            chunkEndIndex(
              getOrCreateActiveSession(session.callSid).spatialIndex,
              dictationIndex * TRACKING_DICTATION_CHUNK_SIZE,
            );
          setLastSpokenIndex(session.callSid, endIndex);
        }

        await streamChunkToMediaStream(
          event.chunk,
          send,
          {
            abortSignal: abort.signal,
            streamSid,
            onAudioSent: () => {
              touchOutboundAudio(session.callSid);
              outboundPowerByCall.set(session.callSid, 2500);
            },
          },
          session.callSid,
        );
        if (abort.signal.aborted) {
          interruptedDuringSpeech = true;
          break;
        }
      }

      if (event.type === "done") {
        endCall = event.endCall ?? false;
        clearDictationLock(session.callSid);
        setAgentRelayState(session.callSid, "LISTENING");
      }
    }
  } catch (err) {
    logger.error("media_stream_turn_error", {
      callSid: session.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    if (!abort.signal.aborted) {
      await streamChunkToMediaStream(
        { text: VOICE_LAYER_ERROR_SPEECH, kind: "error" },
        send,
        {
          abortSignal: abort.signal,
          streamSid,
          onAudioSent: () => {
            touchOutboundAudio(session.callSid);
            outboundPowerByCall.set(session.callSid, 2500);
          },
        },
        session.callSid,
      );
    }
  } finally {
    speakingTurns.delete(session.callSid);
    activeTurnAborts.delete(session.callSid);
  }

  if (interruptedDuringSpeech && session) {
    void enqueueStreamTurn(session.callSid, () =>
      runStreamingTurn(session, USER_INTERRUPTED_DICTATION_SIGNAL, send, streamSid, setAbort),
    );
    return;
  }

  if (endCall && !abort.signal.aborted && session) {
    TerminationCoordinator.terminate(session, "transport_stop", {
      sendMediaStreamStop: () => sendMediaStreamStop(send, streamSid),
    });
  }
}

/** @deprecated Use conversationRelayHandler.handleConversationRelaySocket for live calls. */
export { handleConversationRelaySocket } from "./conversationRelayHandler.js";

export function applyRelayInterrupt(ctx: {
  getSession: () => CallSession | null;
}): Promise<{ action: "aborted" | "ignored" }> {
  const callSid = ctx.getSession()?.callSid;
  if (!callSid || !speakingTurns.has(callSid)) {
    return Promise.resolve({ action: "ignored" });
  }
  return abortCurrentTTS(callSid, true).then((aborted) => ({
    action: aborted ? "aborted" : "ignored",
  }));
}

export function registerRelaySend(): void {
  // no-op — Media Streams register per connection in handleMediaStreamSocket
}

export function unregisterRelaySend(callSid: string): void {
  unregisterStreamSend(callSid);
}
