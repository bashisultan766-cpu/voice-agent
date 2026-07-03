/**
 * Hard caller firewall — Shopify/order tools may only run from conversationOrchestrator.
 */
import { pipelineTrace } from "../utils/pipelineTrace.js";
import { getActivePipelineCallSid, ORCHESTRATOR_OWNER } from "./pipelineGuard.js";

let activeCaller: string | null = null;
let testBypassEnabled = false;

export function runWithToolAuthorization<T>(caller: string, fn: () => T): T {
  const previous = activeCaller;
  activeCaller = caller;
  try {
    return fn();
  } finally {
    activeCaller = previous;
  }
}

export async function runWithToolAuthorizationAsync<T>(
  caller: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = activeCaller;
  activeCaller = caller;
  try {
    return await fn();
  } finally {
    activeCaller = previous;
  }
}

export function assertToolAccessAuthorized(tool: string, sourceFile: string): void {
  if (testBypassEnabled) return;
  if (activeCaller !== ORCHESTRATOR_OWNER) {
    const stack = new Error().stack ?? "";
    const callSid = getActivePipelineCallSid();
    pipelineTrace({
      layer: "tool",
      file: sourceFile,
      callSid,
      action: "ILLEGAL_TOOL_EXECUTION_BYPASS",
      extra: { tool, caller: activeCaller, stack: stack.split("\n").slice(0, 8).join("\n") },
    });
    throw new Error(`ILLEGAL_TOOL_EXECUTION_BYPASS: ${tool}`);
  }
}

export function enableToolAccessForTests(enabled = true): void {
  testBypassEnabled = enabled;
}

export function resetToolAccessGuard(): void {
  testBypassEnabled = false;
  activeCaller = null;
}
