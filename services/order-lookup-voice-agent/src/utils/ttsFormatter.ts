/**
 * TTS formatting helpers — slow dictation for alphanumeric IDs on voice calls.
 */
import { getConfig } from "../config.js";

const TRACKING_CHAR_PAUSE_MS = 500;

export interface FormatTrackingNumberOptions {
  /** Override config — SSML breaks for ElevenLabs; comma spacing otherwise. */
  useSsml?: boolean;
}

/**
 * Format a tracking ID for extremely slow, clear TTS dictation.
 * ElevenLabs / Twilio ConversationRelay: SSML pause between every character.
 * Other engines: spaced comma-separated characters.
 */
export function formatTrackingNumberForTTS(
  trackingId: string,
  options?: FormatTrackingNumberOptions,
): string {
  const normalized = trackingId.trim().toUpperCase();
  if (!normalized) return "";

  const chars = [...normalized];
  const useSsml =
    options?.useSsml ??
    getConfig().VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs";

  if (useSsml) {
    return chars
      .map((char) => `${char}<break time="${TRACKING_CHAR_PAUSE_MS}ms"/>`)
      .join("");
  }

  return chars.map((char) => `${char} ,`).join(" ");
}
