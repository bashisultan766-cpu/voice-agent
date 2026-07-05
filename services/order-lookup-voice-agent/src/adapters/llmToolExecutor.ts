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
} from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import { logger } from "../utils/logger.js";
import { formatTrackingNumberForTTS } from "../utils/ttsFormatter.js";

export type LlmToolName =
  | "get_shopify_order_status"
  | "search_shopify_book_by_isbn"
  | "search_shopify_book_by_title";

export interface LlmToolExecutionRecord {
  tool: LlmToolName;
  args: Record<string, string>;
  ok: boolean;
  status:
    | "found"
    | "not_found"
    | "invalid_format"
    | "api_error"
    | "system_maintenance"
    | "throttled"
    | "blocked";
  data?: OrderStatusResult | BookAvailabilityResult;
  errorMessage?: string;
  elapsedMs: number;
}

/** Sanitized tool payload — never expose raw Shopify errors to the LLM. */
export const SYSTEM_MAINTENANCE_LLM_PAYLOAD = {
  error: "SYSTEM_MAINTENANCE" as const,
  instructions:
    "Do not mention API keys or technical issues. Apologize to the user and state the catalog system is undergoing brief maintenance.",
};

/** Strict NOT_FOUND payload — LLM must not invent order fields when this is returned. */
export function buildOrderNotFoundLlmPayload(searchedNumber: string) {
  return {
    status: "NOT_FOUND" as const,
    searched_number: searchedNumber.replace(/^#/, ""),
    error: "No exact match found in Shopify.",
  };
}

function isMaintenanceToolStatus(status: LlmToolExecutionRecord["status"]): boolean {
  return (
    status === "system_maintenance" ||
    status === "api_error" ||
    status === "throttled"
  );
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

function maintenanceRecord(
  tool: LlmToolName,
  args: Record<string, string>,
  started: number,
): LlmToolExecutionRecord {
  return {
    tool,
    args,
    ok: false,
    status: "system_maintenance",
    data: {
      status: "system_maintenance",
      message: "Catalog temporarily unavailable",
    },
    elapsedMs: Date.now() - started,
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
    const rawInput = args.orderNumber ?? "";
    const orderNumber = normalizeOrderNumber(rawInput);
    const gate = validateShopifyExecutionGate(
      "order_status",
      gateExtraction("order_status", { orderNumber, slotType: "order_number" }),
    );
    if (!gate.allowed || !orderNumber || !isValidOrderNumberFormat(orderNumber)) {
      return {
        tool,
        args: { orderNumber: rawInput },
        ok: false,
        status: "blocked",
        errorMessage: gate.clarificationText,
        elapsedMs: Date.now() - started,
      };
    }

    logger.info("Executing Shopify Lookup for Normalized Order Number: ", {
      original: rawInput,
      normalized: orderNumber,
    });

    try {
      const data = await getOrderStatus(orderNumber, callSid);
      return {
        tool,
        args: { orderNumber },
        ok: data.status === "found",
        status: data.status,
        data,
        elapsedMs: Date.now() - started,
      };
    } catch {
      return maintenanceRecord(tool, { orderNumber }, started);
    }
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

    try {
      const data = await searchByISBN(isbn, callSid);
      return {
        tool,
        args: { isbn },
        ok: data.status === "found",
        status: data.status,
        data,
        elapsedMs: Date.now() - started,
      };
    } catch {
      return maintenanceRecord(tool, { isbn }, started);
    }
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

  try {
    const data = await searchByTitle(title, callSid);
    return {
      tool,
      args: { title },
      ok: data.status === "found",
      status: data.status,
      data,
      elapsedMs: Date.now() - started,
    };
  } catch {
    return maintenanceRecord(tool, { title }, started);
  }
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

  if (isMaintenanceToolStatus(record.status)) {
    return JSON.stringify(SYSTEM_MAINTENANCE_LLM_PAYLOAD);
  }

  if (record.data && "status" in record.data && isMaintenanceToolStatus(record.data.status)) {
    return JSON.stringify(SYSTEM_MAINTENANCE_LLM_PAYLOAD);
  }

  if (record.tool === "get_shopify_order_status" && record.status === "not_found") {
    const searchedNumber =
      record.args.orderNumber ??
      (record.data && "searchedNumber" in record.data
        ? String(record.data.searchedNumber ?? "")
        : "");
    const payload = buildOrderNotFoundLlmPayload(searchedNumber);
    logger.info("tool_output_to_llm", {
      tool: "get_shopify_order_status",
      output: payload,
    });
    return JSON.stringify(payload);
  }

  if (!record.data) {
    return JSON.stringify({ status: record.status, found: false });
  }

  if (record.tool === "get_shopify_order_status" && "orderNumber" in record.data) {
    if (record.data.status !== "found") {
      const searchedNumber = record.args.orderNumber ?? record.data.searchedNumber ?? "";
      const payload = buildOrderNotFoundLlmPayload(String(searchedNumber));
      logger.info("tool_output_to_llm", {
        tool: "get_shopify_order_status",
        output: payload,
      });
      return JSON.stringify(payload);
    }

    const payload = {
      status: "FOUND",
      found: true,
      data: shapeOrderStatusForLlm(record.data),
      instructions:
        "Deep-fetch data is for internal memory only. On first response after FOUND, give ONLY the order status per ORDER LOOKUP S.O.P. — do not read items, prices, or refund details until the caller asks. Provide specific fields only when explicitly requested. For tracking ID requests, follow TRACKING ID PROTOCOL and use tracking_number_for_tts verbatim in Phase 2. If refund_notification_email, payment_method_last4, or payment_gateway is null, omit that detail — never invent a replacement.",
    };
    logger.info("tool_output_to_llm", {
      tool: "get_shopify_order_status",
      output: payload,
    });
    return JSON.stringify(payload);
  }

  return JSON.stringify({
    status: record.data.status,
    found: record.data.status === "found",
    data: record.data,
  });
}

/** Snake_case order payload — matches system prompt field names exactly. */
function shapeOrderStatusForLlm(data: OrderStatusResult): Record<string, unknown> {
  const trackingNumber = data.trackingNumber ?? null;
  return {
    order_number: data.orderNumber ?? null,
    customer_name: data.customerName ?? null,
    customer_email: data.customerEmail ?? null,
    items: data.lineItems ?? null,
    total_amount: data.totalAmount ?? null,
    shipping_amount: data.shippingFee ?? null,
    subtotal_amount: data.subtotalAmount ?? null,
    payment_method_last4: data.cardLast4 ?? null,
    payment_gateway: data.paymentGateway ?? null,
    card_brand: data.cardBrand ?? null,
    refund_status: data.refundStatus ?? null,
    refund_reason: data.refundReason ?? null,
    refund_amount: data.refundAmount ?? null,
    refund_notification_email: data.refundNotificationEmail ?? data.refundEmail ?? null,
    order_placed_at: data.orderPlacedAt ?? null,
    refund_date: data.refundDate ?? null,
    fulfillment_status: data.fulfillmentStatus ?? null,
    estimated_delivery_days: data.estimatedDeliveryDays ?? null,
    tracking_number: trackingNumber,
    tracking_company: data.trackingCompany ?? null,
    tracking_number_for_tts: trackingNumber
      ? formatTrackingNumberForTTS(trackingNumber)
      : null,
    tracking_status: data.trackingStatus ?? null,
  };
}
