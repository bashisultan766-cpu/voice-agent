/**
 * Hard execution firewall — tools MUST NOT run during Phase 1 (slot filling).
 */
import { logger } from "../utils/logger.js";

export type ExecutionPhase = "PHASE_1" | "PHASE_2";

export interface ToolExecutionState {
  phase: ExecutionPhase;
  callSid?: string;
}

const callPhase = new Map<string, ExecutionPhase>();
let activeCallSid: string | undefined;

/** Test-only bypass for direct tool unit tests (never enabled in production). */
let testBypassEnabled = false;

export function setToolExecutionPhase(callSid: string, phase: ExecutionPhase): void {
  callPhase.set(callSid, phase);
  activeCallSid = callSid;
}

export function canExecuteTool(state?: ToolExecutionState | null): boolean {
  if (testBypassEnabled) return true;
  if (state?.phase === "PHASE_2") return true;
  if (state?.phase === "PHASE_1") return false;

  const callSid = state?.callSid ?? activeCallSid;
  if (!callSid) return false;
  return callPhase.get(callSid) === "PHASE_2";
}

export function getExecutionState(callSid?: string): ToolExecutionState {
  const sid = callSid ?? activeCallSid;
  return {
    phase: sid ? (callPhase.get(sid) ?? "PHASE_1") : "PHASE_1",
    callSid: sid,
  };
}

export function logToolCallAttempt(tool: string): void {
  const state = getExecutionState();
  const allowed = canExecuteTool(state);
  console.log("TOOL CALL ATTEMPT:", { tool, phase: state.phase, allowed, callSid: state.callSid });
  logger.info("tool_call_attempt", {
    tool,
    phase: state.phase,
    allowed,
    callSid: state.callSid?.slice(0, 8),
  });
}

export function assertToolExecutionAllowed(tool: string): void {
  logToolCallAttempt(tool);
  if (!canExecuteTool()) {
    throw new Error("TOOL_BLOCKED_PHASE_1");
  }
}

export async function runInPhase2<T>(callSid: string, fn: () => Promise<T>): Promise<T> {
  const previous = callPhase.get(callSid) ?? "PHASE_1";
  setToolExecutionPhase(callSid, "PHASE_2");
  try {
    return await fn();
  } finally {
    setToolExecutionPhase(callSid, previous);
  }
}

/** Enable/disable guard bypass for isolated tool unit tests. */
export function enableToolExecutionForTests(enabled = true): void {
  testBypassEnabled = enabled;
}

export function resetToolExecutionGuard(): void {
  testBypassEnabled = false;
  callPhase.clear();
  activeCallSid = undefined;
}

export function clearCallExecutionPhase(callSid: string): void {
  callPhase.delete(callSid);
  if (activeCallSid === callSid) activeCallSid = undefined;
}
