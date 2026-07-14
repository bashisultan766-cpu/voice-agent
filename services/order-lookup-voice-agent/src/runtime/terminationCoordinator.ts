/**
 * TerminationCoordinator — sole owner of call hang-up decisions + transport teardown.
 * LLM end_call, follow-up goodbye, Relay stop, and Media Streams stop all route here.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  shouldBlockPrematureEndCall as shouldBlockPrematureFromLlm,
} from "../services/llmService.js";
import { isLockedFlowState } from "../agents/lockedFlowState.js";
import { planGoodbye } from "../agents/responsePlanner.js";
import { clearCallerMemory } from "../utils/callerMemory.js";
import { ensureSessionMemory } from "../agents/sessionMemory.js";

export type TerminationReason =
  | "llm_end_call"
  | "follow_up_goodbye"
  | "explicit_goodbye"
  | "relay_socket_close"
  | "media_stream_socket_close"
  | "transport_stop"
  | "REMOTE_DISCONNECT";

export interface TerminationDecision {
  allow: boolean;
  reason: TerminationReason;
  speech?: string;
  blockReason?: string;
}

export interface TransportTeardownAdapters {
  sendEndCall?: () => void;
  sendMediaStreamStop?: () => void;
}

/** Shared anti-hangup gate used by all termination entry points. */
export function evaluateTermination(
  session: CallSession,
  reason: TerminationReason,
  utterance?: string,
): TerminationDecision {
  // Remote transport closure always tears down — call already ended upstream.
  if (reason === "relay_socket_close" || reason === "media_stream_socket_close") {
    return { allow: true, reason: "REMOTE_DISCONNECT" };
  }
  if (reason === "REMOTE_DISCONNECT") {
    return { allow: true, reason };
  }

  if (isLockedFlowState(session)) {
    return {
      allow: false,
      reason,
      blockReason: "locked_flow_state",
      speech:
        "I still have a payment link in progress for you. Let's finish that first, or say goodbye again if you're sure.",
    };
  }

  const text = (utterance ?? "").trim();
  if (
    text &&
    shouldBlockPrematureFromLlm({
      userMessage: text,
      session,
    })
  ) {
    return {
      allow: false,
      reason,
      blockReason: "premature_end_call",
      speech:
        "It looks like we're still working on your cart or checkout. I can keep helping — or say goodbye when you're ready to end the call.",
    };
  }

  // Cart mid-edit block for follow-up goodbye path (parity with LLM gate).
  if (
    reason === "follow_up_goodbye" &&
    (session.shoppingCart?.length ?? 0) > 0 &&
    !/\b(goodbye|bye|end\s+call|hang\s+up)\b/i.test(text)
  ) {
    return {
      allow: false,
      reason,
      blockReason: "cart_active",
      speech: "You still have books in your cart. Want to finish checkout, or say goodbye to end the call?",
    };
  }

  return {
    allow: true,
    reason,
    speech: planGoodbye().text,
  };
}

export interface TerminateCallResult {
  ended: boolean;
  speech?: string;
  blockReason?: string;
}

/**
 * Sole hang-up entry — updates session phase and invokes transport teardown adapters.
 */
export function terminateCall(
  session: CallSession,
  reason: TerminationReason,
  adapters?: TransportTeardownAdapters,
  utterance?: string,
): TerminateCallResult {
  if (session.phase === "ended" || ensureSessionMemory(session).terminationCompleted) {
    return { ended: true };
  }
  const decision = evaluateTermination(session, reason, utterance);
  if (!decision.allow) {
    logger.info("termination_blocked", {
      call_id: session.callSid.slice(0, 12),
      reason,
      blockReason: decision.blockReason,
    });
    return { ended: false, speech: decision.speech, blockReason: decision.blockReason };
  }

  session.phase = "ended";
  ensureSessionMemory(session).terminationCompleted = true;
  clearCallerMemory(session.callerPhone ?? session.from);

  try {
    adapters?.sendEndCall?.();
  } catch (err) {
    logger.warn("termination_send_end_call_failed", {
      call_id: session.callSid.slice(0, 12),
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    adapters?.sendMediaStreamStop?.();
  } catch (err) {
    logger.warn("termination_media_stop_failed", {
      call_id: session.callSid.slice(0, 12),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("termination_executed", {
    call_id: session.callSid.slice(0, 12),
    reason,
  });

  return { ended: true, speech: decision.speech };
}

export const TerminationCoordinator = {
  evaluate: evaluateTermination,
  terminate: terminateCall,
} as const;
