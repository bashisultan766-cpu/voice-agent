/**
 * Shared voice pre-turn pipeline — ConversationRelay and Media Streams both route here.
 * Centralizes incomplete-utterance / LISTENING_WAIT / progressive recovery.
 *
 * Turn-state machine (Atomic Reliability):
 *   LISTENING → (incomplete clause) → LISTENING_WAIT
 *   LISTENING_WAIT + promptStage N → Interjection speech (buffer KEPT; no new enum)
 *   LISTENING_WAIT → (complete clause) → proceed → LISTENING (only then clear buffer)
 *
 * We deliberately do NOT add a PROMPTING relay state — interjections are events
 * inside LISTENING_WAIT via promptStage, so the orchestrator always expects
 * utterance continuation rather than a turn reset.
 */
import type { CallSession } from "../types/order.js";
import { ensureSessionMemory } from "../agents/sessionMemory.js";
import {
  decideTurnEnd,
  mergeListeningWaitBuffer,
} from "../adapters/turnEndHeuristics.js";
import { setAgentRelayState } from "../sovereign/activeSession.js";
import { logger } from "../utils/logger.js";
import { VERIFICATION_SILENCE_PROMPT_MS } from "../streaming/audioProcessor.js";
import { isEmailConfirmationActive } from "../agents/emailConfirmationManager.js";
import { randomUUID } from "node:crypto";
import { cancelListeningWaitTimer } from "./listeningWaitTimerCancel.js";

export type VoiceTransport = "conversation_relay" | "media_streams";

export interface VoiceEvent {
  transport: VoiceTransport;
  callId: string;
  text: string;
  turnId?: string;
  isFinal?: boolean;
}

export type PreTurnDecision =
  | { action: "proceed"; text: string }
  | { action: "listening_wait"; text: string; speech?: string; waitId: string }
  /** @deprecated Prefer listening_wait interjections; kept for transport switch exhaustiveness. */
  | { action: "listening_wait_timeout"; text: string; speech: string };

/** Progressive wait prompts — prevent indefinite LISTENING_WAIT deadlock. */
export const LISTENING_WAIT_MAX_MS = 12_000;
export const LISTENING_WAIT_FIRST_PROMPT_MS = 6_000;
/** Gap between progressive silence interjections after the first. */
export const LISTENING_WAIT_PROMPT_INTERVAL_MS = 3_000;

const WAIT_PROMPTS = [
  "Take your time — I'm still listening.",
  "Whenever you're ready, go ahead.",
  "I'm here when you want to continue. What would you like to do?",
];

function enterListeningWait(session: CallSession, merged: string, reason: string): string {
  const memory = ensureSessionMemory(session);
  memory.listeningWaitBuffer = merged;
  if (!memory.listeningWaitEnteredAt) {
    memory.listeningWaitEnteredAt = Date.now();
    memory.listeningWaitPromptCount = 0;
  }
  if (!memory.listeningWait) {
    memory.listeningWait = {
      waitId: randomUUID(),
      reason,
      startedAt: memory.listeningWaitEnteredAt,
      promptStage: memory.listeningWaitPromptCount ?? 0,
    };
  }
  setAgentRelayState(session.callSid, "LISTENING_WAIT");
  return memory.listeningWait.waitId;
}

/**
 * Clear wait metadata ONLY when leaving the wait phase (complete clause / proceed).
 * Never call from the silence-timer interjection path.
 */
function clearListeningWait(session: CallSession): void {
  cancelListeningWaitTimer(session.callSid);
  const memory = ensureSessionMemory(session);
  memory.listeningWaitBuffer = undefined;
  memory.listeningWaitEnteredAt = undefined;
  memory.listeningWaitPromptCount = undefined;
  memory.listeningWait = undefined;
  setAgentRelayState(session.callSid, "LISTENING");
}

export function isWaitActive(session: CallSession, waitId: string): boolean {
  return ensureSessionMemory(session).listeningWait?.waitId === waitId;
}

/**
 * Stale-safe silence-timer callback for either voice transport.
 * NEVER clears the buffer — stays in LISTENING_WAIT and emits an interjection.
 */
export function onListeningWaitTimer(
  session: CallSession,
  waitId: string,
): PreTurnDecision | null {
  if (!isWaitActive(session, waitId)) return null;

  const memory = ensureSessionMemory(session);
  const text = memory.listeningWaitBuffer ?? "";
  const promptCount = memory.listeningWaitPromptCount ?? 0;
  const speech = WAIT_PROMPTS[Math.min(promptCount, WAIT_PROMPTS.length - 1)]!;

  if (promptCount < WAIT_PROMPTS.length) {
    memory.listeningWaitPromptCount = promptCount + 1;
    if (memory.listeningWait) {
      memory.listeningWait.promptStage = promptCount + 1;
    }
  }

  // Buffer + wait metadata intentionally preserved.
  setAgentRelayState(session.callSid, "LISTENING_WAIT");

  logger.info(
    `[ListeningWaitTimer] callSid=${session.callSid} action="fired" waitId=${waitId} bufferLength=${text.length}`,
    {
      callSid: session.callSid.slice(0, 8),
      action: "fired",
      waitId,
      bufferLength: text.length,
      promptStage: memory.listeningWaitPromptCount ?? 0,
    },
  );

  return { action: "listening_wait", text, speech, waitId };
}

/**
 * Sole pre-turn processor for both Twilio transports.
 * Returns proceed | listening_wait (buffer preserved across interjections).
 */
export function processVoicePreTurn(
  session: CallSession,
  event: VoiceEvent,
): PreTurnDecision {
  const memory = ensureSessionMemory(session);

  // User spoke while a silence timer may be running — cancel immediately.
  cancelListeningWaitTimer(session.callSid);

  if (memory.listeningWaitEnteredAt || memory.listeningWaitBuffer) {
    logger.info(
      `[ListeningWaitTimer] callSid=${session.callSid} action="transcript_received" bufferLength=${(memory.listeningWaitBuffer ?? "").length}`,
      {
        callSid: session.callSid.slice(0, 8),
        action: "transcript_received",
        transport: event.transport,
        bufferLength: (memory.listeningWaitBuffer ?? "").length,
        incomingLength: event.text.length,
        waitId: memory.listeningWait?.waitId,
      },
    );
  }

  const merged = mergeListeningWaitBuffer(memory.listeningWaitBuffer, event.text);
  const turnEnd = decideTurnEnd(merged);

  if (turnEnd.action === "listening_wait") {
    const waitId = enterListeningWait(session, merged, turnEnd.reason);
    const enteredAt = memory.listeningWaitEnteredAt ?? Date.now();
    const waited = Date.now() - enteredAt;
    const promptCount = memory.listeningWaitPromptCount ?? 0;

    // Opportunistic interjection if the caller kept producing incomplete fragments
    // past the first prompt window (timer may also fire independently).
    if (waited >= LISTENING_WAIT_FIRST_PROMPT_MS && promptCount < WAIT_PROMPTS.length) {
      memory.listeningWaitPromptCount = promptCount + 1;
      if (memory.listeningWait) memory.listeningWait.promptStage = promptCount + 1;
      logger.info("vad_listening_wait_prompt", {
        call_id: session.callSid.slice(0, 12),
        transport: event.transport,
        waitedMs: waited,
        promptStage: promptCount + 1,
        bufferLength: merged.length,
      });
      return {
        action: "listening_wait",
        text: merged,
        speech: WAIT_PROMPTS[promptCount],
        waitId,
      };
    }

    logger.info("vad_listening_wait", {
      call_id: session.callSid.slice(0, 12),
      transport: event.transport,
      reason: turnEnd.reason,
      preview: merged.slice(0, 80),
      bufferLength: merged.length,
      waitId,
    });
    return { action: "listening_wait", text: merged, waitId };
  }

  // Complete clause — only safe place to drop the buffer.
  clearListeningWait(session);
  return { action: "proceed", text: merged };
}

/** Silence wait for verification vs normal VAD. */
export function silenceWaitMsForSession(session: CallSession): number {
  if (
    isEmailConfirmationActive(session) ||
    ensureSessionMemory(session).listeningWaitEnteredAt
  ) {
    return Math.max(1000, VERIFICATION_SILENCE_PROMPT_MS);
  }
  return 1000;
}

export const VoicePreTurn = {
  process: processVoicePreTurn,
  silenceWaitMsForSession,
  isWaitActive,
  onListeningWaitTimer,
  LISTENING_WAIT_MAX_MS,
  LISTENING_WAIT_FIRST_PROMPT_MS,
  LISTENING_WAIT_PROMPT_INTERVAL_MS,
} as const;
