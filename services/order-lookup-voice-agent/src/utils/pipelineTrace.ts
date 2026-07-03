/**
 * Unified pipeline tracing — streamHandler → orchestrator → gate → tool.
 */
export type PipelineLayer = "streamHandler" | "orchestrator" | "gate" | "tool" | "state";

export function pipelineTrace(input: {
  layer: PipelineLayer;
  file: string;
  callSid?: string;
  action: string;
  state?: unknown;
  extra?: Record<string, unknown>;
}): void {
  console.log({
    layer: input.layer,
    file: input.file,
    callSid: input.callSid?.slice(0, 8),
    action: input.action,
    state: input.state,
    ...input.extra,
  });
}
