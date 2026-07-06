/**
 * Executes OpenAI tool calls against Shopify with zero-hallucination validation.
 */
import {
  getOrderStatus,
  getCustomerHistory,
  searchByISBN,
  searchByTitle,
  createShopifyDraftOrder,
  type BookAvailabilityResult,
  type CustomerHistoryResult,
  type OrderStatusResult,
} from "./shopifyStorefrontAdapter.js";
import {
  addToCart,
  getCartSummary,
  removeFromCart,
} from "../agents/cartManager.js";
import { applyCallerVerificationFromOrder } from "../agents/callerVerification.js";
import type { CallSession } from "../types/order.js";
import {
  isResendAvailable,
  isValidCustomerEmail,
  sendCheckoutEmail,
  sendSupportEscalation,
} from "../utils/resendEmailService.js";
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
import {
  extractRefundNotificationEmailFromMessages,
} from "./orderFieldExtractors.js";
import {
  formatEmailForTTS,
  formatTrackingNumberForTTS,
} from "../utils/ttsFormatter.js";

export type LlmToolName =
  | "get_shopify_order_status"
  | "get_customer_history"
  | "search_shopify_book_by_isbn"
  | "search_shopify_book_by_title"
  | "add_to_cart"
  | "remove_from_cart"
  | "get_cart_summary"
  | "send_checkout_email"
  | "send_support_escalation"
  | "end_call";

export interface CartToolResult {
  status: "ok" | "empty" | "error";
  items?: Array<{
    title: string;
    quantity: number;
    variant_id?: string;
    product_id?: string;
    unit_price?: string;
    price?: string;
  }>;
  total_units?: number;
  message?: string;
}

export interface CheckoutEmailToolResult {
  status: "sent" | "failed" | "error" | "blocked";
  invoice_url?: string;
  draft_order_name?: string;
  reason?: string;
  message?: string;
}

export interface SupportEscalationToolResult {
  status: "sent" | "error" | "blocked";
  message?: string;
}

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
    | "blocked"
    | "ok"
    | "empty"
    | "sent"
    | "error"
    | "failed";
  data?:
    | OrderStatusResult
    | CustomerHistoryResult
    | BookAvailabilityResult
    | CartToolResult
    | CheckoutEmailToolResult
    | SupportEscalationToolResult;
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
  session?: CallSession,
): Promise<LlmToolExecutionRecord> {
  const started = Date.now();
  const args = Object.fromEntries(
    Object.entries(rawArgs).map(([k, v]) => [k, String(v ?? "").trim()]),
  );

  if (tool === "end_call") {
    return {
      tool,
      args,
      ok: true,
      status: "ok",
      elapsedMs: Date.now() - started,
    };
  }

  if (!session && (
    tool === "add_to_cart" ||
    tool === "remove_from_cart" ||
    tool === "get_cart_summary" ||
    tool === "send_checkout_email" ||
    tool === "send_support_escalation"
  )) {
    return {
      tool,
      args,
      ok: false,
      status: "blocked",
      errorMessage: "Session unavailable for cart operation.",
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "add_to_cart" && session) {
    try {
      const items = parseCartItemsArg(rawArgs.items);
      if (!items.length) {
        return {
          tool,
          args,
          ok: false,
          status: "blocked",
          errorMessage: "Provide at least one item with title or variant_id.",
          elapsedMs: Date.now() - started,
        };
      }
      const cart = addToCart(session, items);
      const data: CartToolResult = {
        status: "ok",
        items: cart.map((line) => ({
          title: line.title,
          quantity: line.quantity,
          variant_id: line.variantId,
          product_id: line.productId,
          unit_price: line.unitPrice ?? line.price,
          price: line.unitPrice ?? line.price,
        })),
        total_units: cart.reduce((sum, line) => sum + line.quantity, 0),
      };
      return { tool, args, ok: true, status: "ok", data, elapsedMs: Date.now() - started };
    } catch {
      return cartErrorRecord(tool, args, started);
    }
  }

  if (tool === "remove_from_cart" && session) {
    try {
      const items = parseCartItemsArg(rawArgs.items);
      const cart = removeFromCart(session, items);
      const data: CartToolResult = {
        status: cart.length ? "ok" : "empty",
        items: cart.map((line) => ({
          title: line.title,
          quantity: line.quantity,
          variant_id: line.variantId,
          product_id: line.productId,
        })),
        total_units: cart.reduce((sum, line) => sum + line.quantity, 0),
      };
      return { tool, args, ok: true, status: cart.length ? "ok" : "empty", data, elapsedMs: Date.now() - started };
    } catch {
      return cartErrorRecord(tool, args, started);
    }
  }

  if (tool === "get_cart_summary" && session) {
    const summary = getCartSummary(session);
    const data: CartToolResult = {
      status: summary.isEmpty ? "empty" : "ok",
      items: summary.items.map((line) => ({
        title: line.title,
        quantity: line.quantity,
        variant_id: line.variantId,
        product_id: line.productId,
        unit_price: line.unitPrice ?? line.price,
        price: line.unitPrice ?? line.price,
      })),
      total_units: summary.totalUnits,
      message: summary.isEmpty ? "Cart is empty." : undefined,
    };
    return {
      tool,
      args,
      ok: !summary.isEmpty,
      status: summary.isEmpty ? "empty" : "ok",
      data,
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "send_checkout_email" && session) {
    const customerEmail = (args.customerEmail ?? args.email ?? "").trim();
    const customerName = (args.customerName ?? args.name ?? "").trim();

    if (!isValidCustomerEmail(customerEmail)) {
      return {
        tool,
        args: { customerEmail, customerName },
        ok: false,
        status: "blocked",
        errorMessage: "Valid customer email required before sending checkout link.",
        elapsedMs: Date.now() - started,
      };
    }

    const summary = getCartSummary(session);
    if (summary.isEmpty) {
      return {
        tool,
        args: { customerEmail, customerName },
        ok: false,
        status: "empty",
        errorMessage: "Cart is empty — add books before checkout.",
        elapsedMs: Date.now() - started,
      };
    }

    if (!isResendAvailable()) {
      return {
        tool,
        args: { customerEmail, customerName },
        ok: false,
        status: "error",
        errorMessage: "Email service is not configured.",
        elapsedMs: Date.now() - started,
      };
    }

    try {
      const draft = await createShopifyDraftOrder(
        summary.items.map((line) => ({
          quantity: line.quantity,
          variantId: line.variantId.startsWith("custom:") ? undefined : line.variantId,
          title: line.title,
          originalUnitPrice: line.unitPrice ?? line.price,
        })),
        customerEmail,
        customerName,
        callSid,
      );

      if (!draft.success || !draft.invoiceUrl) {
        const reason = draft.error ?? draft.message ?? "Could not create checkout link.";
        const data: CheckoutEmailToolResult = {
          status: "failed",
          reason,
          message: reason,
        };
        return {
          tool,
          args: { customerEmail, customerName },
          ok: false,
          status: draft.status === "throttled" ? "throttled" : "failed",
          errorMessage: reason,
          data,
          elapsedMs: Date.now() - started,
        };
      }

      session.pendingInvoiceUrl = draft.invoiceUrl;
      session.pendingDraftOrderName = draft.draftOrderName;

      const emailResult = await sendCheckoutEmail(
        customerEmail,
        customerName,
        draft.invoiceUrl,
        summary.items,
      );

      const data: CheckoutEmailToolResult = {
        status: emailResult.ok ? "sent" : "error",
        invoice_url: draft.invoiceUrl,
        draft_order_name: draft.draftOrderName,
        message: emailResult.ok
          ? "Checkout email sent successfully."
          : emailResult.error ?? "Could not send checkout email.",
      };

      return {
        tool,
        args: { customerEmail, customerName },
        ok: emailResult.ok,
        status: emailResult.ok ? "sent" : "error",
        data,
        elapsedMs: Date.now() - started,
      };
    } catch {
      return {
        tool,
        args: { customerEmail, customerName },
        ok: false,
        status: "api_error",
        errorMessage: "Checkout failed. Please try again.",
        elapsedMs: Date.now() - started,
      };
    }
  }

  if (tool === "send_support_escalation" && session) {
    const customerName = (args.customerName ?? args.name ?? "").trim();
    const customerEmail = (args.customerEmail ?? args.email ?? "").trim();
    const issueSummary = (args.issueSummary ?? args.summary ?? "").trim();

    if (!issueSummary) {
      return {
        tool,
        args,
        ok: false,
        status: "blocked",
        errorMessage: "Provide a concise issue summary for support.",
        elapsedMs: Date.now() - started,
      };
    }

    if (!isResendAvailable()) {
      return {
        tool,
        args,
        ok: false,
        status: "error",
        errorMessage: "Email service is not configured.",
        elapsedMs: Date.now() - started,
      };
    }

    try {
      const emailResult = await sendSupportEscalation(
        customerName,
        customerEmail,
        session.from,
        issueSummary,
      );
      const data: SupportEscalationToolResult = {
        status: emailResult.ok ? "sent" : "error",
        message: emailResult.ok
          ? "Support team notified."
          : emailResult.error ?? "Could not notify support.",
      };
      return {
        tool,
        args: { customerName, customerEmail, issueSummary },
        ok: emailResult.ok,
        status: emailResult.ok ? "sent" : "error",
        data,
        elapsedMs: Date.now() - started,
      };
    } catch {
      return {
        tool,
        args,
        ok: false,
        status: "api_error",
        errorMessage: "Escalation failed. Please try again.",
        elapsedMs: Date.now() - started,
      };
    }
  }

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
      if (session && data.status === "found") {
        applyCallerVerificationFromOrder(session, data);
      }
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

  if (tool === "get_customer_history") {
    if (!session) {
      return {
        tool,
        args,
        ok: false,
        status: "blocked",
        errorMessage: "Session unavailable for customer history.",
        elapsedMs: Date.now() - started,
      };
    }

    if (!session.isVerifiedCaller) {
      return {
        tool,
        args,
        ok: false,
        status: "blocked",
        errorMessage: "UNAUTHORIZED: You cannot fetch history details for unverified callers.",
        data: {
          status: "api_error",
          message: "UNAUTHORIZED: You cannot fetch history details for unverified callers.",
          error: "UNAUTHORIZED: You cannot fetch history details for unverified callers.",
        },
        elapsedMs: Date.now() - started,
      };
    }

    const customerId = (args.customerId ?? session.shopifyCustomerId ?? "").trim();
    if (!customerId) {
      return {
        tool,
        args,
        ok: false,
        status: "blocked",
        errorMessage: "Customer ID unavailable — complete an order lookup first.",
        elapsedMs: Date.now() - started,
      };
    }

    try {
      const data = await getCustomerHistory(customerId, callSid);
      return {
        tool,
        args: { customerId },
        ok: data.status === "found",
        status: data.status,
        data,
        elapsedMs: Date.now() - started,
      };
    } catch {
      return maintenanceRecord(tool, { customerId }, started);
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

  if (
    record.tool === "add_to_cart" ||
    record.tool === "remove_from_cart" ||
    record.tool === "get_cart_summary"
  ) {
    return JSON.stringify({
      status: record.status,
      ok: record.ok,
      cart: record.data,
      instructions:
        record.tool === "get_cart_summary"
          ? "Summarize the cart naturally for the caller."
          : "Confirm the cart change warmly and ask if they want anything else.",
    });
  }

  if (record.tool === "send_checkout_email") {
    if (!record.ok) {
      const checkout = record.data as CheckoutEmailToolResult | undefined;
      const reason = checkout?.reason ?? record.errorMessage ?? "Checkout failed.";
      return JSON.stringify({
        status: "failed",
        reason,
        checkout,
        instructions:
          "Do NOT say the system is undergoing updates. Apologize to the customer, state exactly which book caused the problem using the reason field, and immediately call send_support_escalation with a concise issueSummary.",
      });
    }
    return JSON.stringify({
      status: record.status,
      ok: record.ok,
      checkout: record.data,
      instructions:
        "Tell the caller their secure payment link was emailed and they should complete facility/inmate details on checkout.",
    });
  }

  if (record.tool === "send_support_escalation") {
    return JSON.stringify({
      status: record.status,
      ok: record.ok,
      escalation: record.data,
      instructions: record.ok
        ? 'Say exactly: "I have sent your request to the support team. They will contact you shortly."'
        : "Apologize and offer to try again or take their callback number.",
    });
  }

  if (record.tool === "end_call") {
    return JSON.stringify({
      status: "ok",
      ok: true,
      instructions: "Say a brief warm goodbye. The call will end after you speak.",
    });
  }

  if (record.tool === "search_shopify_book_by_title") {
    const data = record.data as BookAvailabilityResult;
    if (data.status === "not_found") {
      return JSON.stringify({
        status: "NOT_FOUND",
        queriedTitle: data.queriedTitle,
        instructions:
          "Follow OMNI-CHANNEL ESCALATION S.O.P.: ask for email, verify letter-by-letter, call send_support_escalation, then say: I have sent your request to the support team. They will contact you shortly.",
      });
    }
    const similar = data.similarMatches ?? [];
    const volumeHint =
      data.exactMatch === false && similar.length > 1
        ? "You could not find the EXACT volume. Read the top 2 or 3 entries from similarMatches aloud (bookName, inStock, price) and ask if they want one. Use variant_id and price from the chosen match for add_to_cart."
        : "If in stock, offer to add to cart using variant_id and unit_price from this response. If out of stock, follow OMNI-CHANNEL ESCALATION S.O.P.";
    return JSON.stringify({
      status: data.status,
      found: data.status === "found",
      data,
      variant_id: data.variantId,
      similarMatches: similar,
      instructions: volumeHint,
    });
  }

  if (record.tool === "get_customer_history") {
    const data = record.data as CustomerHistoryResult;
    if (data.status !== "found") {
      return JSON.stringify({
        status: data.status,
        ok: false,
        message: data.message ?? data.error,
      });
    }
    return JSON.stringify({
      status: "FOUND",
      ok: true,
      orderCount: data.orderCount ?? data.orders?.length ?? 0,
      orders: data.orders ?? [],
      instructions:
        "Follow VIP ORDER HISTORY DRILL-DOWN S.O.P.: first summarize unique monthYear values only and ask which month to explore. After the caller picks a month, read items, totalAmount, status, and orderNumber for that month only. Never dump all orders at once.",
    });
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
        "Deep-fetch data is for internal memory only, including the full timeline events array (internal — never read verbatim; no staff names). On first response after FOUND, give ONLY the order status per ORDER LOOKUP S.O.P. — do not read items, prices, or refund details until the caller asks. Provide specific fields only when explicitly requested. Keys always present: customer_name, customer_email, customer_email_for_tts, order_placed_at, payment_method_last4, card_brand, refund_notification_email, order_confirmation_email (null when absent — never invent). For spoken refund notification email, use refund_notification_email_for_tts (full speakable address, e.g. jamaicathompson87 at gmail dot com). If refund_notification_email is null and order_placed_at is over 1 year old, apply LEGACY ORDER FALLBACK from INTERNATIONAL PROTOCOL using order_placed_at and customer_email_for_tts — never say not on file for archived orders with customer_email on file. If the caller asks about refund status, notification email, or payment method, follow INTERNATIONAL PROTOCOL — never say information is not on file when those fields are non-null. For tracking ID requests, follow TRACKING ID PROTOCOL and use tracking_number_for_tts verbatim in Phase 2. If a field is null on a recent order (within 1 year), state clearly that the detail is not on file — never invent a replacement.",
    };
    logger.info("tool_output_to_llm", {
      tool: "get_shopify_order_status",
      output: payload,
    });
    return JSON.stringify(payload);
  }

  return JSON.stringify({
    status: "status" in record.data ? record.data.status : record.status,
    found: "status" in record.data ? record.data.status === "found" : record.ok,
    data: record.data,
    variant_id: "variantId" in record.data ? record.data.variantId : undefined,
    instructions:
      record.tool === "search_shopify_book_by_isbn"
        ? "If in stock, offer to add to cart using variant_id and unit_price (from the price field) from this response. If out of stock, follow GRACEFUL ESCALATION."
        : undefined,
  });
}

function parseCartItemsArg(raw: unknown): Array<{
  variant_id?: string;
  product_id?: string;
  title?: string;
  isbn?: string;
  unit_price?: string;
  price?: string;
  quantity?: number;
}> {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (typeof item !== "object" || item === null) return {};
      const obj = item as Record<string, unknown>;
      const unitPrice = String(obj.unit_price ?? obj.unitPrice ?? obj.price ?? "");
      return {
        variant_id: String(obj.variant_id ?? obj.variantId ?? ""),
        product_id: String(obj.product_id ?? obj.productId ?? ""),
        title: String(obj.title ?? ""),
        isbn: String(obj.isbn ?? ""),
        unit_price: unitPrice,
        price: unitPrice,
        quantity: Number(obj.quantity ?? 1),
      };
    });
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const unitPrice = String(obj.unit_price ?? obj.unitPrice ?? obj.price ?? "");
    return [
      {
        variant_id: String(obj.variant_id ?? obj.variantId ?? ""),
        product_id: String(obj.product_id ?? obj.productId ?? ""),
        title: String(obj.title ?? ""),
        isbn: String(obj.isbn ?? ""),
        unit_price: unitPrice,
        price: unitPrice,
        quantity: Number(obj.quantity ?? 1),
      },
    ];
  }
  return [];
}

function cartErrorRecord(
  tool: LlmToolName,
  args: Record<string, string>,
  started: number,
): LlmToolExecutionRecord {
  return {
    tool,
    args,
    ok: false,
    status: "api_error",
    errorMessage: "Cart update failed. Please try again.",
    elapsedMs: Date.now() - started,
  };
}

/** Keys that must always exist on session.currentOrderData / LLM payloads (null allowed). */
export const OMNI_EXTRACTOR_PAYLOAD_KEYS = [
  "customer_name",
  "payment_method_last4",
  "card_brand",
  "refund_notification_email",
  "order_confirmation_email",
] as const;

/** Sanitized snake_case order fields for session memory and LLM follow-up context. */
export function buildActiveOrderContextPayload(
  data: OrderStatusResult,
  session?: CallSession,
): Record<string, unknown> {
  return shapeOrderStatusForLlm(data, session);
}

/**
 * Snake_case order payload — matches system prompt field names exactly.
 * Omni-Extractor keys (customer_name, payment_method_last4, card_brand,
 * refund_notification_email) are always present — never dropped or sanitized out.
 */
function shapeOrderStatusForLlm(
  data: OrderStatusResult,
  session?: CallSession,
): Record<string, unknown> {
  const trackingNumber = data.trackingNumber ?? null;
  const refundNotificationEmail =
    data.refundNotificationEmail ??
    data.refundEmail ??
    extractRefundNotificationEmailFromMessages(
      Array.isArray(data.events) ? data.events.map(String) : [],
    ) ??
    null;
  const orderConfirmationEmail = data.orderConfirmationEmail ?? null;
  const verified = session?.isVerifiedCaller === true;
  const payload: Record<string, unknown> = {
    order_number: data.orderNumber ?? null,
    customer_name: data.customerName ?? null,
    customer_email: data.customerEmail ?? null,
    customer_email_for_tts: formatEmailForTTS(data.customerEmail ?? null),
    is_verified_caller: verified,
    total_order_count: data.totalOrderCount ?? session?.totalOrderCount ?? null,
    shipping_address: verified ? (data.shippingAddress ?? null) : null,
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
    refund_notification_email: refundNotificationEmail,
    refund_notification_email_for_tts: formatEmailForTTS(refundNotificationEmail),
    order_confirmation_email: orderConfirmationEmail,
    order_confirmation_email_for_tts: formatEmailForTTS(orderConfirmationEmail),
    events: data.events ?? [],
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

  // Payload synchronization guard — these keys must never be omitted.
  for (const key of OMNI_EXTRACTOR_PAYLOAD_KEYS) {
    if (!(key in payload)) {
      payload[key] = null;
    }
  }

  return payload;
}
