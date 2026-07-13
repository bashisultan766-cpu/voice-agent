/**
 * UnifiedToolRegistry — single entry for LLM tool schemas + executeUnifiedTool().
 *
 * All OpenAI function-calling tool executions must enter here (via ServiceRegistry).
 * Zod validation + secure UnifiedCallSession injection run before Shopify/Resend.
 */
import type OpenAI from "openai";
import type { CallSession } from "../types/order.js";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  getTurnGeneration,
  isStaleTurnGeneration,
} from "../runtime/turnAbortRegistry.js";
import { TimeoutError, withTimeout } from "../utils/promiseTimeout.js";
import {
  executeLlmTool,
  type LlmToolExecutionRecord,
  type LlmToolName,
} from "./llmToolExecutor.js";
import {
  injectSecureToolContext,
  listRegisteredToolNames,
  prepareUnifiedToolArgs,
} from "./toolExecutionPolicy.js";

export type { LlmToolExecutionRecord, LlmToolName };
export {
  injectSecureToolContext,
  listRegisteredToolNames,
  prepareUnifiedToolArgs,
};

/**
 * Canonical OpenAI function-calling schemas for the ShoreShot tool surface.
 * Kept in the registry so adapters and the execution pipeline share one source.
 */
export const UNIFIED_OPENAI_TOOL_SCHEMAS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_shopify_order_status",
      description:
        "Fetch or use order details from Shopify. Use when the caller asks for customer name, order status, refund reason, totals, payment method, or order history context on the current order. Pass ONLY the digit sequence for a new lookup — strip filler words. When ACTIVE ORDER CONTEXT is already loaded for the same order, answer from that JSON instead of re-fetching unless they give a different order number.",
      parameters: {
        type: "object",
        properties: {
          orderNumber: {
            type: "string",
            description:
              "Order digits only (e.g. 21698 or 21698-F1). Extract from rambling speech — never pass 'uhh', 'please', or full sentences. Translate non-English number words to digits first. Never guess. Never pass an ISBN here.",
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
      name: "get_customer_history",
      description:
        "Fetch the caller's compressed recent order history (up to 15 orders: orderNumber, monthYear, totalAmount, status, items). ONLY for verified callers after a successful order lookup. Customer identity is taken from the secure call session — do not invent customerId. Use VIP ORDER HISTORY DRILL-DOWN S.O.P. when speaking results.",
      parameters: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description:
              "Optional. Ignored when the session already has a Shopify customer id — the pipeline injects it securely.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_shopify_book_by_isbn",
      description:
        "Search the SureShot Books catalog by ISBN. Pass ONLY digit characters — strip filler and phonetic noise from spoken ISBN.",
      parameters: {
        type: "object",
        properties: {
          isbn: {
            type: "string",
            description:
              "ISBN digits only (10 or 13). Extract from spoken input — ignore 'uhh', 'the number is', and phonetic letter qualifiers. Never pass conversational filler.",
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
      description:
        "Search the SureShot Books catalog by book title. Returns up to 5 similar volume/variant matches. Strip conversational filler only — preserve brand names, apostrophes (Lindy's), and year ranges in the title argument. Translate non-English titles to English before calling.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "The caller's full semantic book title phrase — keep brand/vendor names, possessives, apostrophes, and edition years. Example: caller says 'Do you have Lindy's 2026 to 2027 National College Football' → pass that exact phrase (not a shortened keyword subset).",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dictate_tracking",
      description:
        "ONLY use when the caller explicitly asks for their tracking ID, carrier tracking number, or package/shipment location. Never use for customer name, order status, refund questions, or general order details. Requires pen-and-notepad readiness before speaking digits. Never pass an ISBN as a tracking number.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_cart_item_quantity",
      description:
        "Unified cart updater for SureShot Books. ALWAYS use this tool for cart changes — never invent separate add/remove tools. " +
        "Parameters: item_id or variant_id (or sku/title), quantity (integer), action_type enum add | remove | set_exact. " +
        "RULE 1 ABSOLUTE ASSIGNMENT: If the caller says 'Make it X', 'I want X copies', 'Change it to X', 'I just want X total', or 'set it to X', you MUST use action_type=set_exact with quantity X. " +
        "RULE 2 NEGATION & CORRECTION: If the caller says 'No, not X, I want Y', 'Don't add more, make it Y', or 'No, don't add, I just want Y total', recognize the correction and use action_type=set_exact with quantity Y — NEVER add Y on top of the current cart. " +
        "RULE 3 RELATIVE ONLY WHEN EXPLICIT: Use action_type=add ONLY for phrases like 'add X more', 'give me X extra', 'add X copies'. Use action_type=remove ONLY for 'remove X', 'minus X', 'take away X'. " +
        "Always pass unit_price from the latest catalog search with variant_id when available.",
      parameters: {
        type: "object",
        properties: {
          action_type: {
            type: "string",
            enum: ["add", "remove", "set_exact"],
            description:
              "add = increase by quantity; remove = decrease by quantity (floor 0); set_exact = replace line quantity with quantity.",
          },
          quantity: {
            type: "number",
            description: "Integer quantity for the chosen action_type.",
          },
          item_id: {
            type: "string",
            description: "Product/variant identifier (Shopify ProductVariant GID preferred).",
          },
          variant_id: {
            type: "string",
            description: "Shopify ProductVariant GID from search results (alias of item_id).",
          },
          sku: {
            type: "string",
            description: "Optional SKU when variant GID is unavailable.",
          },
          title: { type: "string", description: "Book title for matching the cart line." },
          product_id: { type: "string" },
          isbn: { type: "string" },
          unit_price: {
            type: "string",
            description: "Per-unit catalog price from search (e.g. 12.99).",
          },
          items: {
            type: "array",
            description: "Optional multi-line payload; each line uses the same action_type.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                variant_id: { type: "string" },
                item_id: { type: "string" },
                sku: { type: "string" },
                product_id: { type: "string" },
                isbn: { type: "string" },
                unit_price: { type: "string" },
                quantity: { type: "number" },
              },
            },
          },
        },
        required: ["action_type", "quantity"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cart_summary",
      description: "Return the caller's current shopping cart contents.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_checkout_email",
      description:
        "After email verification, create a Shopify draft order and email the secure checkout link to the customer. Prefer the session-confirmed email — the pipeline injects it when available.",
      parameters: {
        type: "object",
        properties: {
          customerEmail: {
            type: "string",
            description: "Verified customer email — any valid domain.",
          },
          customerName: { type: "string", description: "Customer full name." },
        },
        required: ["customerEmail", "customerName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_support_escalation",
      description:
        "Email jessica@sureshotbooks.com after letter-by-letter email verification when a book cannot be found, is out of stock, an unverified caller needs account help, or the issue cannot be resolved on the call.",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          customerEmail: { type: "string" },
          issueSummary: {
            type: "string",
            description: "Concise summary of the unresolved issue for support.",
          },
        },
        required: ["issueSummary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_pending_email",
      description:
        "During collect_email or pending_confirmation, update the pending email on UnifiedCallSession when the caller corrects spelling, a letter, the domain, or asks to start over with a new address. Pass the full corrected email. Then read it back letter-by-letter (no phonetic 'as in' cues) and ask for confirmation.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "Full corrected email address (e.g. bashisultan766@gmail.com).",
          },
        },
        required: ["email"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description:
        "Invoke ONLY when the caller is explicitly done: goodbye, thank you, okay bye, or 'no' after you asked if they need anything else. NEVER use during cart modifications, quantity changes, or partial-title shopping. Say the SureShot goodbye line first, then call this tool.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

export interface UnifiedToolRegistryEntry {
  name: LlmToolName;
  openAiSchema: OpenAI.Chat.ChatCompletionTool;
}

/** Registry index: name → OpenAI schema (for introspection / tests). */
export const UnifiedToolRegistry: ReadonlyMap<LlmToolName, UnifiedToolRegistryEntry> =
  new Map(
    UNIFIED_OPENAI_TOOL_SCHEMAS.filter(
      (t): t is OpenAI.Chat.ChatCompletionTool & { function: { name: string } } =>
        t.type === "function" && Boolean(t.function?.name),
    ).map((t) => {
      const name = t.function.name as LlmToolName;
      return [name, { name, openAiSchema: t }] as const;
    }),
  );

/**
 * Single impenetrable pipeline for every LLM-triggered tool execution.
 * Validates with Zod, injects UnifiedCallSession secrets, then runs Shopify/Resend logic.
 * Hard-capped so a hung Shopify call cannot silence the voice stream.
 */
export async function executeUnifiedTool(
  tool: LlmToolName,
  rawArgs: Record<string, unknown>,
  callSid: string,
  session?: CallSession,
): Promise<LlmToolExecutionRecord> {
  const prepared = prepareUnifiedToolArgs(tool, rawArgs, callSid, session);
  if (!prepared.ok) {
    return prepared.record;
  }

  const started = Date.now();
  const generation = getTurnGeneration(callSid);
  const timeoutMs = getConfig().TOOL_EXECUTION_TIMEOUT_MS;

  try {
    const record = await withTimeout(
      executeLlmTool(tool, prepared.args, callSid, prepared.session, {
        skipPolicy: true,
      }),
      timeoutMs,
      `tool:${tool}`,
    );

    if (isStaleTurnGeneration(callSid, generation)) {
      logger.info("tool_result_discarded_stale_turn", {
        callSid: callSid.slice(0, 8),
        tool,
        generation,
      });
      return {
        tool,
        args: Object.fromEntries(
          Object.entries(prepared.args).map(([k, v]) => [k, String(v ?? "")]),
        ),
        ok: false,
        status: "blocked",
        errorMessage: "Turn aborted — tool result discarded",
        elapsedMs: Date.now() - started,
      };
    }

    return record;
  } catch (err) {
    if (isStaleTurnGeneration(callSid, generation)) {
      return {
        tool,
        args: Object.fromEntries(
          Object.entries(prepared.args).map(([k, v]) => [k, String(v ?? "")]),
        ),
        ok: false,
        status: "blocked",
        errorMessage: "Turn aborted — tool result discarded",
        elapsedMs: Date.now() - started,
      };
    }

    const timedOut =
      err instanceof TimeoutError ||
      /timed out/i.test(err instanceof Error ? err.message : String(err));

    logger.warn("unified_tool_execution_failed", {
      callSid: callSid.slice(0, 8),
      tool,
      timedOut,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      tool,
      args: Object.fromEntries(
        Object.entries(prepared.args).map(([k, v]) => [k, String(v ?? "")]),
      ),
      ok: false,
      status: "api_error",
      errorMessage: timedOut ? "Shopify API timeout" : "Tool execution failed",
      data: {
        status: "api_error",
        message: timedOut ? "Shopify API timeout" : "Tool execution failed",
      },
      elapsedMs: Date.now() - started,
    };
  }
}
