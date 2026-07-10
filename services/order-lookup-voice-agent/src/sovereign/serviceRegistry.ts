/**
 * ServiceRegistry — single entry point for all agent tool execution.
 * Routes through executeUnifiedTool (Zod + secure session inject + Shopify/Resend).
 */
import {
  executeUnifiedTool,
  type LlmToolExecutionRecord,
  type LlmToolName,
} from "../adapters/unifiedToolRegistry.js";
import { toolResultForLlm } from "../adapters/llmToolExecutor.js";
import type { CallSession } from "../types/order.js";

export type { LlmToolExecutionRecord, LlmToolName };

export const ServiceRegistry = {
  executeTool(
    tool: LlmToolName,
    args: Record<string, unknown>,
    callSid: string,
    session?: CallSession,
  ): Promise<LlmToolExecutionRecord> {
    return executeUnifiedTool(tool, args, callSid, session);
  },

  formatToolResult(record: LlmToolExecutionRecord): string {
    return toolResultForLlm(record);
  },
};
