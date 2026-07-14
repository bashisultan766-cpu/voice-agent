/**
 * VAD / barge-in audio processor — calm conversational pacing for Media Streams.
 * Source of Truth for silence endpointing and interrupt sensitivity.
 */
import { MULAW_SILENCE_BYTE } from "../utils/telephonyAudio.js";

/** Wait a full second of silence before treating the caller turn as complete. */
export const VAD_SILENCE_THRESHOLD_MS = 1000;

/** Alias used by stream handlers (same value). */
export const SILENCE_MS = VAD_SILENCE_THRESHOLD_MS;

/**
 * During email / identity verification, wait this long of silence before any
 * gentle "still there?" prompt — never interrupt natural pauses.
 */
export const VERIFICATION_SILENCE_PROMPT_MS = 3000;

/**
 * Agent must have been quiet this long before inbound energy can count as barge-in.
 * Prevents echo / crosstalk from aborting TTS mid-phrase.
 */
export const BARGE_IN_MIN_AGENT_SILENCE_MS = 400;

/** Inbound RMS must exceed recent outbound RMS by this ratio. */
export const BARGE_IN_POWER_RATIO = 2.75;

/** Sustained loud inbound frames required before aborting agent TTS. */
export const BARGE_IN_HOLD_MS = 280;

export type ListeningMode = "LISTENING" | "LISTENING_WAIT" | "SPEAKING";

function mulawByteToLinear(byte: number): number {
  const mu = ~byte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** Mean absolute amplitude of μ-law PCM (proxy for input/output power). */
export function estimateMulawPower(mulaw: Buffer): number {
  if (!mulaw.length) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < mulaw.length; i++) {
    const b = mulaw[i]!;
    if (b === MULAW_SILENCE_BYTE) {
      n += 1;
      continue;
    }
    sum += Math.abs(mulawByteToLinear(b));
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

export interface BargeInDecisionInput {
  inboundMulaw: Buffer;
  /** Recent agent outbound power estimate (0 if unknown). */
  agentOutboundPower: number;
  /** ms since last outbound audio frame was sent. */
  agentSilentForMs: number;
  /** ms of continuous high-power inbound already accumulated. */
  sustainedInboundMs: number;
}

export interface BargeInDecision {
  allow: boolean;
  inboundPower: number;
  reason?: string;
}

/**
 * Low-sensitivity barge-in: only abort agent TTS when caller is clearly louder
 * than agent output AND the agent has been silent long enough AND energy held.
 */
export function evaluateBargeIn(input: BargeInDecisionInput): BargeInDecision {
  const inboundPower = estimateMulawPower(input.inboundMulaw);
  const agentFloor = Math.max(input.agentOutboundPower, 80);

  if (input.agentSilentForMs < BARGE_IN_MIN_AGENT_SILENCE_MS) {
    return {
      allow: false,
      inboundPower,
      reason: "agent_still_speaking",
    };
  }

  if (inboundPower < agentFloor * BARGE_IN_POWER_RATIO) {
    return {
      allow: false,
      inboundPower,
      reason: "inbound_power_too_low",
    };
  }

  if (input.sustainedInboundMs < BARGE_IN_HOLD_MS) {
    return {
      allow: false,
      inboundPower,
      reason: "inbound_not_sustained",
    };
  }

  return { allow: true, inboundPower };
}

export const AudioProcessor = {
  VAD_SILENCE_THRESHOLD_MS,
  SILENCE_MS,
  BARGE_IN_MIN_AGENT_SILENCE_MS,
  BARGE_IN_POWER_RATIO,
  BARGE_IN_HOLD_MS,
  estimateMulawPower,
  evaluateBargeIn,
} as const;
