/**
 * Conversation Brain — single entry point for all voice turns.
 * Twilio / streamHandler MUST import only from this file.
 */
import { logger } from "../utils/logger.js";
import { sanitizeForSpeech } from "../utils/security.js";
import { runOrchestratorTurn } from "./conversationOrchestrator.js";
import type { AgentStreamEvent, CallSession } from "../types/order.js";

/** Fixed greeting spoken at call start (TwiML welcomeGreeting). */
export const BRAIN_GREETING =
  "Hi, this is SureShot Books Assistant. How can I help you today?";

export interface BrainTurnResult {
  speech: string;
  endCall?: boolean;
  phase: CallSession["phase"];
}

export function createCallSession(callSid: string, from: string, to: string): CallSession {
  return {
    callSid,
    from,
    to,
    phase: "greeting",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    awaitingInput: null,
    greetedThisCall: false,
    productSlots: undefined,
  };
}

/** Streaming turn — sole runtime path from Twilio relay. */
export async function* streamBrainTurn(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  const text = sanitizeForSpeech((callerText ?? "").trim());

  try {
    yield* runOrchestratorTurn(session, text);
  } catch (err) {
    logger.error("conversation_brain_turn_failed", {
      callSid: session.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    yield {
      type: "chunk",
      chunk: {
        text: "Sorry, something went wrong on my end. Could you try that once more?",
        kind: "error",
      },
    };
    yield { type: "done", phase: session.phase };
  }
}

/** Collect full turn for tests and legacy callers. */
export async function handleBrainTurn(
  session: CallSession,
  callerText: string,
): Promise<BrainTurnResult> {
  const parts: string[] = [];
  let phase = session.phase;
  let endCall = false;

  for await (const event of streamBrainTurn(session, callerText)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
    if (event.type === "done") {
      phase = event.phase;
      endCall = event.endCall ?? false;
    }
  }

  return { speech: parts.join(" "), phase, endCall };
}
