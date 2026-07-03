/**
 * OpenAI tool-calling adapter — ElevenLabs-style fluid dialogue with Shopify tools.
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../prompts/systemPrompt.js";
import {
  executeLlmTool,
  toolResultForLlm,
  type LlmToolExecutionRecord,
  type LlmToolName,
} from "./llmToolExecutor.js";
import type { FinalResponseType } from "../runtime/turnObservability.js";

export const SHOPIFY_LLM_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_shopify_order_status",
      description:
        "Fetch real order details from Shopify: customer name, line items with quantities, subtotal, shipping fee, status, ETA, refund reason, refund email, and card last four.",
      parameters: {
        type: "object",
        properties: {
          orderNumber: {
            type: "string",
            description:
              "Order number the caller explicitly stated (4-10 digits). Never guess.",
          },
        },
        required: ["orderNumber"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_shopify_book_by_isbn",
      description: "Search the Shoshan catalog by ISBN-10 or ISBN-13.",
      parameters: {
        type: "object",
        properties: {
          isbn: {
            type: "string",
            description: "ISBN digits the caller explicitly read (10 or 13 digits).",
          },
        },
        required: ["isbn"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_shopify_book_by_title",
      description: "Search the Shoshan catalog by book title.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Book title the caller explicitly provided.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
];

export interface LlmChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmAgentTurnInput {
  callSid: string;
  userMessage: string;
  messages: LlmChatMessage[];
}

export interface LlmAgentTurnResult {
  speech: string;
  toolExecutions: LlmToolExecutionRecord[];
  responseType: FinalResponseType;
  recordOrderNumber?: string;
  recordProduct?: { id: string; title: string };
}

export type LlmAgentTurnEvent =
  | { type: "tool_pending"; tools: LlmToolName[] }
  | { type: "result"; result: LlmAgentTurnResult };

type TurnOverride = (input: LlmAgentTurnInput) => Promise<LlmAgentTurnResult>;

let turnOverride: TurnOverride | null = null;

export function setLlmAgentTurnOverride(handler: TurnOverride | null): void {
  turnOverride = handler;
}

export function clearLlmAgentTurnOverride(): void {
  turnOverride = null;
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: getConfig().OPENAI_API_KEY,
      timeout: getConfig().OPENAI_TIMEOUT_MS,
    });
  }
  return client;
}

const MAX_TOOL_ROUNDS = 4;

function isToolName(name: string): name is LlmToolName {
  return (
    name === "get_shopify_order_status" ||
    name === "search_shopify_book_by_isbn" ||
    name === "search_shopify_book_by_title"
  );
}

function inferResponseType(
  speech: string,
  executions: LlmToolExecutionRecord[],
): FinalResponseType {
  const last = executions[executions.length - 1];
  if (!last) {
    if (/\border number\b/i.test(speech)) return "clarification_question";
    return "general_help";
  }

  if (last.tool === "get_shopify_order_status") {
    if (last.ok) return "order_found";
    if (
      last.status === "api_error" ||
      last.status === "system_maintenance" ||
      last.status === "throttled"
    ) {
      return "order_api_error";
    }
    return "order_not_found";
  }

  if (last.ok) return "confirmed_product";
  if (
    last.status === "api_error" ||
    last.status === "system_maintenance" ||
    last.status === "throttled"
  ) {
    return "catalog_degraded";
  }
  return "not_found";
}

function extractRecordMeta(
  executions: LlmToolExecutionRecord[],
): Pick<LlmAgentTurnResult, "recordOrderNumber" | "recordProduct"> {
  const last = executions[executions.length - 1];
  if (!last?.data || last.data.status !== "found") return {};

  if (last.tool === "get_shopify_order_status" && "orderNumber" in last.data) {
    return { recordOrderNumber: last.data.orderNumber };
  }

  if ("bookName" in last.data && last.data.bookName) {
    return {
      recordProduct: {
        id: last.data.productId ?? "unknown",
        title: last.data.bookName,
      },
    };
  }

  return {};
}

function buildOpenAiMessages(
  input: LlmAgentTurnInput,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const history = input.messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  return [
    { role: "system", content: SHOSHAN_SYSTEM_PROMPT },
    ...history,
    { role: "user", content: input.userMessage },
  ];
}

/**
 * Run one caller turn with tool-pending events for system-level filler injection.
 */
export async function* runLlmAgentTurnEvents(
  input: LlmAgentTurnInput,
): AsyncGenerator<LlmAgentTurnEvent> {
  if (turnOverride) {
    const result = await turnOverride(input);
    if (result.toolExecutions.length > 0) {
      yield {
        type: "tool_pending",
        tools: result.toolExecutions.map((exec) => exec.tool),
      };
    }
    yield { type: "result", result };
    return;
  }

  const toolExecutions: LlmToolExecutionRecord[] = [];
  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = buildOpenAiMessages(input);

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await getClient().chat.completions.create({
        model: getConfig().CONVERSATION_BRAIN_MODEL,
        temperature: 0.65,
        max_tokens: 450,
        tools: SHOPIFY_LLM_TOOLS,
        tool_choice: "auto",
        messages,
      });

      const choice = response.choices[0];
      const message = choice?.message;
      if (!message) break;

      const toolCalls = message.tool_calls ?? [];
      const finishReason = choice.finish_reason;

      if (toolCalls.length > 0 && finishReason === "tool_calls") {
        yield {
          type: "tool_pending",
          tools: toolCalls
            .filter((c): c is OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" } =>
              c.type === "function" && isToolName(c.function.name),
            )
            .map((c) => c.function.name as LlmToolName),
        };

        messages = [
          ...messages,
          {
            role: "assistant",
            content: message.content ?? "",
            tool_calls: toolCalls,
          },
        ];

        for (const call of toolCalls) {
          if (call.type !== "function" || !isToolName(call.function.name)) {
            continue;
          }

          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            parsedArgs = {};
          }

          const record = await executeLlmTool(call.function.name, parsedArgs, input.callSid);
          toolExecutions.push(record);

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResultForLlm(record),
          });
        }

        continue;
      }

      const speech = (message.content ?? "").trim();
      if (speech) {
        const responseType = inferResponseType(speech, toolExecutions);
        yield {
          type: "result",
          result: {
            speech,
            toolExecutions,
            responseType,
            ...extractRecordMeta(toolExecutions),
          },
        };
        return;
      }

      break;
    }
  } catch (err) {
    logger.warn("llm_agent_turn_failed", {
      callSid: input.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  yield {
    type: "result",
    result: {
      speech:
        "I'm here to help with book orders and lookups. What would you like to do today?",
      toolExecutions,
      responseType: "general_help",
    },
  };
}

/**
 * Run one caller turn: LLM may issue tool calls, receive Shopify JSON, then synthesize TTS.
 */
export async function runLlmAgentTurn(
  input: LlmAgentTurnInput,
): Promise<LlmAgentTurnResult> {
  let last: LlmAgentTurnResult | undefined;
  for await (const event of runLlmAgentTurnEvents(input)) {
    if (event.type === "result") {
      last = event.result;
    }
  }

  return (
    last ?? {
      speech:
        "I'm here to help with book orders and lookups. What would you like to do today?",
      toolExecutions: [],
      responseType: "general_help",
    }
  );
}
