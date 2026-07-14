/**
 * SharedListeningWaitScheduler — async LISTENING_WAIT interjection timers.
 * Used by Media Streams and Conversation Relay for transport parity.
 *
 * Invariants:
 *   - One timer per callSid (cancel-before-arm; no leaks)
 *   - Stale waitId / inactive session → no-op
 *   - Callback never clears the listening-wait buffer (VoicePreTurn owns that)
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import { ensureSessionMemory } from "../agents/sessionMemory.js";
import {
  LISTENING_WAIT_FIRST_PROMPT_MS,
  LISTENING_WAIT_PROMPT_INTERVAL_MS,
  isWaitActive,
  onListeningWaitTimer,
  type PreTurnDecision,
} from "./voicePreTurn.js";
import {
  armedListeningWaitKeys,
  clearArmedListeningWaitMap,
  deleteArmedListeningWait,
  getArmedListeningWait,
  setArmedListeningWait,
} from "./listeningWaitTimerStore.js";
import { cancelListeningWaitTimer } from "./listeningWaitTimerCancel.js";

export { cancelListeningWaitTimer } from "./listeningWaitTimerCancel.js";

export type ListeningWaitInterjectionHandler = (
  decision: Extract<PreTurnDecision, { action: "listening_wait" }>,
) => void | Promise<void>;

const deliveryByCall = new Map<string, ListeningWaitInterjectionHandler>();
const activeGateByCall = new Map<string, () => boolean>();

export function registerListeningWaitDelivery(
  callSid: string,
  onInterjection: ListeningWaitInterjectionHandler,
  isSessionActive: () => boolean = () => true,
): void {
  deliveryByCall.set(callSid, onInterjection);
  activeGateByCall.set(callSid, isSessionActive);
}

export function unregisterListeningWaitDelivery(callSid: string): void {
  deliveryByCall.delete(callSid);
  activeGateByCall.delete(callSid);
  cancelListeningWaitTimer(callSid);
}

function nextDelayMs(session: CallSession): number {
  const promptCount = ensureSessionMemory(session).listeningWaitPromptCount ?? 0;
  return promptCount === 0
    ? LISTENING_WAIT_FIRST_PROMPT_MS
    : LISTENING_WAIT_PROMPT_INTERVAL_MS;
}

/**
 * Arm (or re-arm) the shared silence interjection timer for an active waitId.
 * Cancels any prior timer for this callSid first.
 */
export function armListeningWaitTimer(
  session: CallSession,
  waitId: string,
  options?: {
    delayMs?: number;
    onInterjection?: ListeningWaitInterjectionHandler;
    isSessionActive?: () => boolean;
  },
): void {
  const callSid = session.callSid;
  if (!callSid || !waitId) return;
  if (!isWaitActive(session, waitId)) return;

  cancelListeningWaitTimer(callSid);

  if (options?.onInterjection) {
    deliveryByCall.set(callSid, options.onInterjection);
  }
  if (options?.isSessionActive) {
    activeGateByCall.set(callSid, options.isSessionActive);
  }

  const delayMs = options?.delayMs ?? nextDelayMs(session);
  const timer = setTimeout(() => {
    const current = getArmedListeningWait(callSid);
    if (current?.waitId === waitId) {
      deleteArmedListeningWait(callSid);
    }

    const gate = activeGateByCall.get(callSid);
    if (gate && !gate()) {
      logger.info(
        `[ListeningWaitTimer] callSid=${callSid} action="stale_inactive" waitId=${waitId}`,
        { callSid: callSid.slice(0, 8), action: "stale_inactive", waitId },
      );
      return;
    }
    if (!isWaitActive(session, waitId)) {
      logger.info(
        `[ListeningWaitTimer] callSid=${callSid} action="stale_waitId" waitId=${waitId}`,
        { callSid: callSid.slice(0, 8), action: "stale_waitId", waitId },
      );
      return;
    }

    const decision = onListeningWaitTimer(session, waitId);
    if (!decision || decision.action !== "listening_wait" || !decision.speech) {
      return;
    }

    const deliver = deliveryByCall.get(callSid);
    if (deliver) {
      void Promise.resolve(deliver(decision)).catch((err) => {
        logger.error("listening_wait_interjection_failed", {
          callSid: callSid.slice(0, 8),
          waitId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Still waiting → re-arm for the next progressive prompt (buffer intact).
    if (isWaitActive(session, waitId)) {
      armListeningWaitTimer(session, waitId);
    }
  }, delayMs);

  setArmedListeningWait(callSid, { waitId, timer });
}

/** Test / teardown helper. */
export function clearAllListeningWaitTimers(): void {
  for (const callSid of armedListeningWaitKeys()) {
    cancelListeningWaitTimer(callSid);
  }
  clearArmedListeningWaitMap();
  deliveryByCall.clear();
  activeGateByCall.clear();
}

export const SharedListeningWaitScheduler = {
  arm: armListeningWaitTimer,
  cancel: cancelListeningWaitTimer,
  registerDelivery: registerListeningWaitDelivery,
  unregisterDelivery: unregisterListeningWaitDelivery,
  clearAll: clearAllListeningWaitTimers,
} as const;
