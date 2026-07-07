/**
 * ServiceRegistry — single entry point for all agent tool execution.
 */
import {
  executeLlmTool,
  toolResultForLlm,
  type LlmToolExecutionRecord,
  type LlmToolName,
} from "../adapters/llmToolExecutor.js";
import type { CallSession } from "../types/order.js";

export type { LlmToolExecutionRecord, LlmToolName };

export const ServiceRegistry = {
  executeTool(
    tool: LlmToolName,
    args: Record<string, unknown>,
    callSid: string,
    session?: CallSession,
  ): Promise<LlmToolExecutionRecord> {
    return executeLlmTool(tool, args, callSid, session);
  },

  formatToolResult(record: LlmToolExecutionRecord): string {
    return toolResultForLlm(record);
  },
};
