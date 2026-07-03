/**
 * Turn health monitor — detects failure patterns requiring self-heal.
 */
import { logger } from "../utils/logger.js";

export interface TurnHealthState {
  consecutiveToolFailures: number;
  consecutiveValidationFailures: number;
  consecutiveApiThrottleFailures: number;
  memoryDesyncEvents: number;
  frustrationSignals: number;
  lastUserUtterance?: string;
  repeatedUtteranceCount: number;
}

const healthByCall = new Map<string, TurnHealthState>();

function emptyHealth(): TurnHealthState {
  return {
    consecutiveToolFailures: 0,
    consecutiveValidationFailures: 0,
    consecutiveApiThrottleFailures: 0,
    memoryDesyncEvents: 0,
    frustrationSignals: 0,
    repeatedUtteranceCount: 0,
  };
}

export function getTurnHealth(callSid: string): TurnHealthState {
  return healthByCall.get(callSid) ?? emptyHealth();
}

export function recordToolSuccess(callSid: string): void {
  const state = getTurnHealth(callSid);
  state.consecutiveToolFailures = 0;
  healthByCall.set(callSid, state);
}

export function recordApiThrottleFailure(callSid: string): void {
  const state = { ...getTurnHealth(callSid) };
  state.consecutiveApiThrottleFailures += 1;
  healthByCall.set(callSid, state);
}

export function clearApiThrottleFailures(callSid: string): void {
  const state = getTurnHealth(callSid);
  state.consecutiveApiThrottleFailures = 0;
  healthByCall.set(callSid, state);
}

export function recordToolFailure(callSid: string): void {
  const state = { ...getTurnHealth(callSid) };
  state.consecutiveToolFailures += 1;
  healthByCall.set(callSid, state);
}

export function recordValidationSuccess(callSid: string): void {
  const state = getTurnHealth(callSid);
  state.consecutiveValidationFailures = 0;
  healthByCall.set(callSid, state);
}

export function recordValidationFailure(callSid: string): void {
  const state = { ...getTurnHealth(callSid) };
  state.consecutiveValidationFailures += 1;
  healthByCall.set(callSid, state);
}

export function recordMemoryDesync(callSid: string): void {
  const state = { ...getTurnHealth(callSid) };
  state.memoryDesyncEvents += 1;
  healthByCall.set(callSid, state);
}

export function recordUserUtterance(callSid: string, text: string): void {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return;
  const state = { ...getTurnHealth(callSid) };
  if (state.lastUserUtterance === normalized) {
    state.repeatedUtteranceCount += 1;
  } else {
    state.repeatedUtteranceCount = 0;
    state.lastUserUtterance = normalized;
  }
  healthByCall.set(callSid, state);
}

export function recordFrustrationSignal(callSid: string): void {
  const state = { ...getTurnHealth(callSid) };
  state.frustrationSignals += 1;
  healthByCall.set(callSid, state);
}

export function resetTurnHealth(callSid: string): void {
  healthByCall.delete(callSid);
}

export function clearAllTurnHealth(): void {
  healthByCall.clear();
}

export function logTurnHealthState(callSid: string, event: string): void {
  const state = getTurnHealth(callSid);
  logger.info("turn_health_state", {
    event,
    callSid: callSid.slice(0, 8),
    ...state,
  });
}
