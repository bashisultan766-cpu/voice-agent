/**
 * Thin cancel helper — imported by voicePreTurn without pulling turnScheduler
 * (which depends on voicePreTurn for onListeningWaitTimer).
 */
import { logger } from "../utils/logger.js";
import { deleteArmedListeningWait } from "./listeningWaitTimerStore.js";

/** Cancel any armed LISTENING_WAIT timer for this call — idempotent. */
export function cancelListeningWaitTimer(callSid: string): void {
  const armed = deleteArmedListeningWait(callSid);
  if (!armed) return;
  clearTimeout(armed.timer);
  logger.info(
    `[ListeningWaitTimer] callSid=${callSid} action="cancelled" waitId=${armed.waitId}`,
    {
      callSid: callSid.slice(0, 8),
      action: "cancelled",
      waitId: armed.waitId,
    },
  );
}
