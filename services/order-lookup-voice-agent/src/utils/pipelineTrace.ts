/**
 * Unified pipeline tracing — streamHandler → orchestrator → gate → tool.
 */
export type PipelineLayer = "streamHandler" | "orchestrator" | "gate" | "tool" | "state";

export function captureCallStack(depth = 8): string {
  return (new Error().stack ?? "").split("\n").slice(1, depth + 1).join("\n");
}

export function pipelineTrace(input: {
  layer: PipelineLayer;
  file: string;
  callSid?: string;
  action: string;
  state?: unknown;
  validationReady?: boolean;
  toolExecutionAllowed?: boolean;
  finalDecision?: "ALLOW_TOOL" | "BLOCK_TOOL";
  includeStack?: boolean;
  extra?: Record<string, unknown>;
}): void {
  console.log({
    layer: input.layer,
    file: input.file,
    callSid: input.callSid?.slice(0, 8),
    action: input.action,
    state: input.state,
    validationReady: input.validationReady,
    toolExecutionAllowed: input.toolExecutionAllowed,
    finalDecision: input.finalDecision,
    ...(input.includeStack ? { stack: captureCallStack() } : {}),
    ...input.extra,
  });
}
