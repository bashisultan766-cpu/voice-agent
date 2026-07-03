/**
 * Pipeline ownership — only conversationOrchestrator may decide tools or mutate call state.
 */
import { pipelineTrace } from "../utils/pipelineTrace.js";

export const ORCHESTRATOR_OWNER = "conversationOrchestrator";

let activeOwner: string | null = null;
let activeCallSid: string | undefined;
let testBypassEnabled = false;

export function beginOrchestratorTurn(callSid: string): void {
  activeOwner = ORCHESTRATOR_OWNER;
  activeCallSid = callSid;
}

export function endOrchestratorTurn(): void {
  activeOwner = null;
  activeCallSid = undefined;
}

export function runAsOrchestrator<T>(callSid: string, fn: () => T): T {
  const previousOwner = activeOwner;
  const previousCallSid = activeCallSid;
  activeOwner = ORCHESTRATOR_OWNER;
  activeCallSid = callSid;
  try {
    return fn();
  } finally {
    activeOwner = previousOwner;
    activeCallSid = previousCallSid;
  }
}

export async function runAsOrchestratorAsync<T>(
  callSid: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previousOwner = activeOwner;
  const previousCallSid = activeCallSid;
  activeOwner = ORCHESTRATOR_OWNER;
  activeCallSid = callSid;
  try {
    return await fn();
  } finally {
    activeOwner = previousOwner;
    activeCallSid = previousCallSid;
  }
}

export function assertOrchestratorOnly(operation: string, file: string): void {
  if (testBypassEnabled) return;
  if (activeOwner !== ORCHESTRATOR_OWNER) {
    const stack = new Error().stack ?? "";
    pipelineTrace({
      layer: "orchestrator",
      file,
      callSid: activeCallSid,
      action: "ILLEGAL_PIPELINE_BYPASS",
      extra: { operation, stack: stack.split("\n").slice(0, 8).join("\n") },
    });
    throw new Error(`ILLEGAL_PIPELINE_BYPASS: ${operation}`);
  }
}

export function enablePipelineGuardForTests(enabled = true): void {
  testBypassEnabled = enabled;
}

export function resetPipelineGuard(): void {
  testBypassEnabled = false;
  activeOwner = null;
  activeCallSid = undefined;
}

export function getActivePipelineCallSid(): string | undefined {
  return activeCallSid;
}
