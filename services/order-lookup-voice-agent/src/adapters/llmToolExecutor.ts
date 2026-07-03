/**
 * Executes OpenAI tool calls against Shopify with zero-hallucination validation.
 */
import {
  getOrderStatus,
  searchByISBN,
  searchByTitle,
  type BookAvailabilityResult,
  type OrderStatusResult,
} from "./shopifyStorefrontAdapter.js";
import {
  validateShopifyExecutionGate,
  type EntityExtractionResult,
} from "../nlp/entityExtractor.js";
import { normalizeIsbn, isValidIsbnFormat } from "../utils/productSearchNormalize.js";
import {
  isValidOrderNumberFormat,
  normalizeOrderNumber,
} from "../utils/formatter.js";

export type LlmToolName =
  | "get_shopify_order_status"
  | "search_shopify_book_by_isbn"
  | "search_shopify_book_by_title";

export interface LlmToolExecutionRecord {
  tool: LlmToolName;
  args: Record<string, string>;
  ok: boolean;
  status: "found" | "not_found" | "invalid_format" | "api_error" | "throttled" | "blocked";
  data?: OrderStatusResult | BookAvailabilityResult;
  errorMessage?: string;
  elapsedMs: number;
}

function gateExtraction(
  intent: EntityExtractionResult["intent"],
  slots: Partial<EntityExtractionResult>,
): EntityExtractionResult {
  return {
    intent,
    slotType: "none",
    confidence: 1,
    ...slots,
  };
}

export async function executeLlmTool(
  tool: LlmToolName,
  rawArgs: Record<string, unknown>,
  callSid: string,
): Promise<LlmToolExecutionRecord> {
  const started = Date.now();
  const args = Object.fromEntries(
    Object.entries(rawArgs).map(([k, v]) => [k, String(v ?? "").trim()]),
  );

  if (tool === "get_shopify_order_status") {
    const orderNumber = normalizeOrderNumber(args.orderNumber ?? "");
    const gate = validateShopifyExecutionGate(
      "order_status",
      gateExtraction("order_status", { orderNumber, slotType: "order_number" }),
    );
    if (!gate.allowed || !orderNumber || !isValidOrderNumberFormat(orderNumber)) {
      return {
        tool,
        args: { orderNumber: args.orderNumber ?? "" },
        ok: false,
        status: "blocked",
        errorMessage: gate.clarificationText,
        elapsedMs: Date.now() - started,
      };
    }

    const data = await getOrderStatus(orderNumber, callSid);
    return {
      tool,
      args: { orderNumber },
      ok: data.status === "found",
      status: data.status,
      data,
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "search_shopify_book_by_isbn") {
    const isbn = normalizeIsbn(args.isbn ?? "");
    const gate = validateShopifyExecutionGate(
      "isbn_search",
      gateExtraction("isbn_search", { isbn, slotType: "isbn" }),
    );
    if (!gate.allowed || !isbn || !isValidIsbnFormat(isbn)) {
      return {
        tool,
        args: { isbn: args.isbn ?? "" },
        ok: false,
        status: "blocked",
        errorMessage: gate.clarificationText,
        elapsedMs: Date.now() - started,
      };
    }

    const data = await searchByISBN(isbn, callSid);
    return {
      tool,
      args: { isbn },
      ok: data.status === "found",
      status: data.status,
      data,
      elapsedMs: Date.now() - started,
    };
  }

  const title = (args.title ?? "").trim();
  const gate = validateShopifyExecutionGate(
    "title_search",
    gateExtraction("title_search", { title, slotType: "title" }),
  );
  if (!gate.allowed) {
    return {
      tool,
      args: { title },
      ok: false,
      status: "blocked",
      errorMessage: gate.clarificationText,
      elapsedMs: Date.now() - started,
    };
  }

  const data = await searchByTitle(title, callSid);
  return {
    tool,
    args: { title },
    ok: data.status === "found",
    status: data.status,
    data,
    elapsedMs: Date.now() - started,
  };
}

/** Compact JSON tool result for the LLM synthesis pass. */
export function toolResultForLlm(record: LlmToolExecutionRecord): string {
  if (record.status === "blocked") {
    return JSON.stringify({
      error: "missing_or_invalid_slot",
      message: record.errorMessage,
      hint: "Ask the caller naturally for the missing information. Do not invent data.",
    });
  }

  if (!record.data) {
    return JSON.stringify({ status: record.status, found: false });
  }

  return JSON.stringify({
    status: record.data.status,
    found: record.data.status === "found",
    data: record.data,
  });
}
