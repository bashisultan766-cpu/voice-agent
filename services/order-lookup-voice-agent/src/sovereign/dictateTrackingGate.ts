/**
 * Notepad gate for tracking dictation — delegates to dictationTool.dictateTracking.
 */
import {
  NotReadyError,
  dictateTracking,
  markTrackingAwaitingNotepad,
  promptUserForNotepad,
  USER_NOTEPAD_READY,
} from "../agents/dictationTool.js";

export { NotReadyError, promptUserForNotepad, USER_NOTEPAD_READY };

export type DictateTrackingIntent = "ReadinessRequest" | "dictate_tracking" | "unavailable";

export interface DictateTrackingResolution {
  intent: DictateTrackingIntent;
  speech: string;
}

export function resolveDictateTracking(callSid: string): DictateTrackingResolution {
  const result = dictateTracking(callSid);

  if (!result.ok) {
    if (result.error.message.includes("do not have a tracking number")) {
      return {
        intent: "unavailable",
        speech: result.error.message,
      };
    }
    markTrackingAwaitingNotepad(callSid);
    return {
      intent: "ReadinessRequest",
      speech: result.error.message,
    };
  }

  return {
    intent: "dictate_tracking",
    speech: result.speech,
  };
}
