import { logger } from "../utils/logger.js";
import { GREETING_PROMPT, ORDER_NOT_FOUND_MESSAGE, SHOPIFY_DOWN_MESSAGE } from "../utils/formatter.js";
import { sanitizeForSpeech } from "../utils/security.js";
import { runOrchestratorTurn } from "./conversationOrchestrator.js";
import type { AgentStreamEvent, CallSession } from "../types/order.js";

export interface AgentTurnResult {
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

/** Streaming turn handler — delegates to conversation orchestrator (single brain). */
export async function* streamAgentTurn(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  const text = sanitizeForSpeech((callerText ?? "").trim());

  try {
    yield* runOrchestratorTurn(session, text);
  } catch (err) {
    logger.error("orchestrator_turn_failed", {
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
export async function handleAgentTurn(
  session: CallSession,
  callerText: string,
): Promise<AgentTurnResult> {
  const parts: string[] = [];
  let phase = session.phase;
  let endCall = false;

  for await (const event of streamAgentTurn(session, callerText)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
    if (event.type === "done") {
      phase = event.phase;
      endCall = event.endCall ?? false;
    }
  }

  return { speech: parts.join(" "), phase, endCall };
}

export async function getInitialGreeting(session: CallSession): Promise<string> {
  session.phase = "awaiting_order_number";
  return GREETING_PROMPT;
}

export { ORDER_NOT_FOUND_MESSAGE, SHOPIFY_DOWN_MESSAGE };
