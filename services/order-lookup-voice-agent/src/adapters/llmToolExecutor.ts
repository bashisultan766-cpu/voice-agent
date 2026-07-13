/**
 * Executes OpenAI tool calls against Shopify with zero-hallucination validation.
 */
import {
  getCustomerHistory,
  searchByISBN,
  searchByTitle,
  type BookAvailabilityResult,
  type CustomerHistoryResult,
  type OrderStatusResult,
} from "./shopifyStorefrontAdapter.js";
import { lookupOrderStatus, clearOrderStatusCache } from "../services/shopifyService.js";
import { aggregateOrderForCaller } from "./orderAggregationEngine.js";
import {
  ensureShoppingCart,
  getCartSummary,
  updateCartItemQuantity,
  type CartActionType,
  type CheckoutItemSelector,
} from "../agents/cartManager.js";
import { sendCheckoutPaymentLink } from "../services/checkoutEmailService.js";
import { recordLastCatalogSearch, reconcileAddToCartItems } from "../agents/catalogTarget.js";
import { shouldSuppressCatalogEscalation } from "../agents/agentBrain.js";
import { runVerificationGate } from "../agents/verificationGate.js";
import { normalizeTrackingIdRawSequence } from "../utils/trackingIdSequence.js";
import type { CallSession } from "../types/order.js";
import {
  isResendAvailable,
  isValidCustomerEmail,
  sendSupportEscalation,
} from "../utils/resendEmailService.js";
import {
  validateShopifyExecutionGate,
  sanitizeCatalogTitlePhrase,
  type EntityExtractionResult,
} from "../nlp/entityExtractor.js";
import { normalizeIsbn, isValidIsbnFormat } from "../utils/productSearchNormalize.js";
import { parseVariantGid } from "../utils/shopifyGid.js";
import { getAgentState } from "../platform/eventDispatcher.js";
import { filterOrderContextForVerification } from "../agents/orderContextPrivacy.js";
import { setOrderHistoryContext } from "../agents/orderHistoryFlow.js";
import type { ActiveOrderContextData } from "../agents/sessionManager.js";
import {
  CATALOG_TOOL_ERROR_LLM_PAYLOAD,
  ORDER_LOOKUP_MAINTENANCE_LLM_PAYLOAD,
  OUT_OF_STOCK_ISBN_MESSAGE,
  SESSION_PERSISTENCE_ERROR_LLM_PAYLOAD,
  SHOPIFY_TIMEOUT_LLM_PAYLOAD,
  SYSTEM_MAINTENANCE_LLM_PAYLOAD,
} from "../constants/systemMessages.js";
import {
  isValidOrderNumberFormat,
} from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import { logger } from "../utils/logger.js";
import { isTurnAborted } from "../runtime/turnAbortRegistry.js";
import {
  extractRefundNotificationEmailFromMessages,
  formatPaymentMethodLabel,
  isValidTrackingNumber,
} from "./orderFieldExtractors.js";
import { physicalItemCount, splitLineItems } from "../utils/productLineItems.js";
import {
  formatEmailForTTS,
  formatTrackingNumberForTTS,
} from "../utils/ttsFormatter.js";
import { SURESHOT_GOODBYE_SPEECH } from "../utils/callerMemory.js";
import { resolveDictateTracking } from "../sovereign/dictateTrackingGate.js";
import { prepareUnifiedToolArgs } from "./toolExecutionPolicy.js";
import {
  flushUnifiedSessionToL2,
  touchUnifiedSession,
} from "../agents/unifiedCallSession.js";

function isCheckoutItemSelector(entry: CheckoutItemSelector | null): entry is CheckoutItemSelector {
  return entry !== null;
}

/** Map unpredictable LLM checkout item payloads into strict CheckoutItemSelector[]. */
function normalizeCheckoutItemArgs(args: Record<string, unknown>): CheckoutItemSelector[] | null {
  const fromItems = Array.isArray(args.items) ? args.items : null;
  if (fromItems?.length) {
    const mapped: Array<CheckoutItemSelector | null> = fromItems.map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;

      const variantIdRaw =
        (typeof row.variant_id === "string" && row.variant_id.trim()) ||
        (typeof row.variantId === "string" && row.variantId.trim()) ||
        (typeof row.item_id === "string" && row.item_id.trim()) ||
        (typeof row.sku === "string" && row.sku.trim()) ||
        "";
      const title = typeof row.title === "string" ? row.title.trim() : "";
      if (!variantIdRaw && !title) return null;

      const quantityRaw = row.quantity;
      const parsedQuantity =
        typeof quantityRaw === "number"
          ? quantityRaw
          : typeof quantityRaw === "string"
            ? Number(quantityRaw)
            : NaN;
      const quantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1;

      const selector: CheckoutItemSelector = {
        variant_id: variantIdRaw || undefined,
        variantId: typeof row.variantId === "string" ? row.variantId.trim() || undefined : undefined,
        item_id: typeof row.item_id === "string" ? row.item_id.trim() || undefined : undefined,
        sku: typeof row.sku === "string" ? row.sku.trim() || undefined : undefined,
        title: title || undefined,
        quantity,
      };
      return selector;
    });

    const selectors = mapped.filter(isCheckoutItemSelector);
    return selectors.length ? selectors : null;
  }

  const ids = [
    ...(Array.isArray(args.variant_ids) ? args.variant_ids : []),
    ...(Array.isArray(args.item_ids) ? args.item_ids : []),
  ].filter((id): id is string => typeof id === "string" && id.trim().length > 0);

  if (!ids.length) return null;
  return ids.map((id) => ({ variant_id: id, quantity: 1 }));
}

export { SYSTEM_MAINTENANCE_LLM_PAYLOAD };

export interface ExecuteLlmToolOptions {
  /** When true, Zod + secure inject already ran (executeUnifiedTool). */
  skipPolicy?: boolean;
}

export type LlmToolName =
  | "get_shopify_order_status"
  | "get_customer_history"
  | "search_shopify_book_by_isbn"
  | "search_shopify_book_by_title"
  | "dictate_tracking"
  | "update_cart_item_quantity"
  | "get_cart_summary"
  | "send_checkout_email"
  | "send_support_escalation"
  | "update_pending_email"
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
  instructions?: string;
}

export interface SupportEscalationToolResult {
  status: "sent" | "error" | "blocked";
  message?: string;
}

export interface DictateTrackingToolResult {
  intent: "ReadinessRequest" | "dictate_tracking" | "unavailable";
  message?: string;
  tracking_number_for_tts?: string;
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
    | SupportEscalationToolResult
    | DictateTrackingToolResult;
  errorMessage?: string;
  elapsedMs: number;
}

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

function catalogErrorRecord(
  tool: LlmToolName,
  args: Record<string, string>,
  started: number,
  reason: string,
): LlmToolExecutionRecord {
  return {
    tool,
    args,
    ok: false,
    status: "api_error",
    errorMessage: reason,
    data: {
      status: "system_maintenance",
      message: reason,
    },
    elapsedMs: Date.now() - started,
  };
}

function persistenceErrorRecord(
  tool: LlmToolName,
  args: Record<string, string>,
  started: number,
): LlmToolExecutionRecord {
  return {
    tool,
    args,
    ok: false,
    status: "api_error",
    errorMessage: SESSION_PERSISTENCE_ERROR_LLM_PAYLOAD.reason,
    data: {
      status: "system_maintenance",
      message: SESSION_PERSISTENCE_ERROR_LLM_PAYLOAD.reason,
    },
    elapsedMs: Date.now() - started,
  };
}

/** After catalog mutations, one locked L2 flush — surfaces persistence exhaustion to the LLM. */
async function flushSessionAfterCatalogMutation(
  session: CallSession | undefined,
  tool: LlmToolName,
  args: Record<string, string>,
  started: number,
): Promise<LlmToolExecutionRecord | null> {
  if (!session) return null;
  touchUnifiedSession(session);
  const flush = await flushUnifiedSessionToL2(session);
  if (!flush.ok) {
    return persistenceErrorRecord(tool, args, started);
  }
  return null;
}

export async function executeLlmTool(
  tool: LlmToolName,
  rawArgs: Record<string, unknown>,
  callSid: string,
  session?: CallSession,
  options?: ExecuteLlmToolOptions,
): Promise<LlmToolExecutionRecord> {
  const started = Date.now();

  let effectiveArgs = rawArgs ?? {};
  let effectiveSession = session;
  if (!options?.skipPolicy) {
    const prepared = prepareUnifiedToolArgs(tool, effectiveArgs, callSid, effectiveSession);
    if (!prepared.ok) {
      return prepared.record;
    }
    effectiveArgs = prepared.args;
    effectiveSession = prepared.session;
  }

  const args = Object.fromEntries(
    Object.entries(effectiveArgs).map(([k, v]) => [
      k,
      typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? String(v).trim()
        : v == null
          ? ""
          : JSON.stringify(v),
    ]),
  );
  // Preserve structured cart payloads for downstream parsers
  const rawArgsForCart = effectiveArgs;
  session = effectiveSession;

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
    tool === "update_cart_item_quantity" ||
    tool === "get_cart_summary" ||
    tool === "send_checkout_email" ||
    tool === "send_support_escalation" ||
    tool === "update_pending_email"
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

  if (tool === "update_pending_email" && session) {
    const { updatePendingEmail } = await import("../agents/emailConfirmationManager.js");
    const email = (args.email ?? args.customerEmail ?? "").trim();
    const result = updatePendingEmail(session, email, email);
    if (!result.ok) {
      return {
        tool,
        args: { email },
        ok: false,
        status: "blocked",
        errorMessage: result.error,
        elapsedMs: Date.now() - started,
      };
    }
    return {
      tool,
      args: { email: result.email },
      ok: true,
      status: "ok",
      data: {
        status: "ok",
        message: `Pending email updated to ${result.email}. spelled_for_tts: ${result.spelled}`,
      } satisfies CartToolResult,
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "update_cart_item_quantity" && session) {
    try {
      const actionRaw = String(
        rawArgsForCart.action_type ?? rawArgsForCart.actionType ?? "add",
      )
        .trim()
        .toLowerCase();
      const actionType: CartActionType =
        actionRaw === "remove" || actionRaw === "set_exact" || actionRaw === "add"
          ? (actionRaw as CartActionType)
          : rawArgsForCart.set_absolute_quantity === true
            ? "set_exact"
            : "add";

      const fromItems = reconcileAddToCartItems(
        session,
        parseCartItemsArg(rawArgsForCart.items),
      );
      const singleItem = {
        title: String(rawArgsForCart.title ?? "").trim() || undefined,
        variant_id: String(
          rawArgsForCart.variant_id ??
            rawArgsForCart.item_id ??
            rawArgsForCart.sku ??
            "",
        ).trim() || undefined,
        product_id: String(rawArgsForCart.product_id ?? "").trim() || undefined,
        isbn: String(rawArgsForCart.isbn ?? "").trim() || undefined,
        unit_price: String(rawArgsForCart.unit_price ?? rawArgsForCart.price ?? "").trim() || undefined,
        quantity: Number(rawArgsForCart.quantity ?? 0) || undefined,
      };
      const items =
        fromItems.length > 0
          ? fromItems
          : singleItem.title || singleItem.variant_id
            ? reconcileAddToCartItems(session, [singleItem])
            : [];

      if (!items.length) {
        return {
          tool,
          args,
          ok: false,
          status: "blocked",
          errorMessage:
            "Provide item_id/variant_id/sku or title, plus quantity and action_type (add | remove | set_exact).",
          elapsedMs: Date.now() - started,
        };
      }

      for (const item of items) {
        const rawVariant = (item.variant_id ?? "").trim();
        if (rawVariant && !rawVariant.startsWith("custom:") && !parseVariantGid(rawVariant)) {
          return {
            tool,
            args,
            ok: false,
            status: "blocked",
            errorMessage: `Invalid Shopify variant id for "${item.title ?? rawVariant}". Use a ProductVariant GID or title-only custom line with unit_price.`,
            elapsedMs: Date.now() - started,
          };
        }
        if (!rawVariant && !(item.title ?? "").trim()) {
          return {
            tool,
            args,
            ok: false,
            status: "blocked",
            errorMessage: "Each cart line needs a valid variant_id/item_id/sku or title.",
            elapsedMs: Date.now() - started,
          };
        }
      }

      let cart = ensureShoppingCart(session);
      for (const item of items) {
        const quantity = Number(item.quantity ?? rawArgsForCart.quantity ?? 1) || 1;
        cart = updateCartItemQuantity(session, item, quantity, actionType);
      }
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
        message: `Cart updated with action_type=${actionType}.`,
      };
      return { tool, args, ok: true, status: "ok", data, elapsedMs: Date.now() - started };
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
    const itemSelectors = normalizeCheckoutItemArgs(args);

    if (!itemSelectors?.length && session.paymentLinkSent) {
      const prior = session.paymentLinkSentTo ?? customerEmail ?? "your email";
      return {
        tool,
        args: { customerEmail, customerName },
        ok: true,
        status: "sent",
        data: {
          status: "sent",
          message: `Payment link was already sent to ${prior} during this call.`,
          instructions:
            "Confirm-once policy for full-cart checkout: do NOT resend. Say the link was already emailed and ask if they need anything else. For split-order remaining books, pass items for the next batch after letter-by-letter email verification.",
        } satisfies CheckoutEmailToolResult,
        elapsedMs: Date.now() - started,
      };
    }

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

    const result = await sendCheckoutPaymentLink(session, customerEmail, {
      customerName,
      items: itemSelectors,
    });
    let status: "sent" | "blocked" | "empty" | "error" | "failed" = result.ok ? "sent" : "failed";
    if (!result.ok) {
      if (/valid customer email/i.test(result.message)) status = "blocked";
      else if (/cart is empty|could not find/i.test(result.message)) status = "empty";
      else if (/not configured/i.test(result.message)) status = "error";
    }
    const data: CheckoutEmailToolResult = {
      status: result.ok ? "sent" : "failed",
      invoice_url: result.invoiceUrl,
      message: result.message,
      reason: result.ok ? undefined : result.message,
      instructions: result.ok
        ? result.splitBatch && (result.remainingCartUnits ?? 0) > 0
          ? "SPLIT BATCH SENT: Confirm this link was emailed. Then ask which remaining books go to the NEXT email. Re-run letter-by-letter email verification for the next address before calling send_checkout_email again with the next items subset. Do NOT collect all emails at once."
          : result.splitBatch
            ? "SPLIT COMPLETE: All cart batches have been emailed. Ask if they need anything else — do NOT auto hang up."
            : undefined
        : result.invoiceUrl
          ? "Email delivery failed but invoice_url is valid — read the checkout link aloud or offer to retry email."
          : undefined,
    };

    return {
      tool,
      args: { customerEmail, customerName },
      ok: result.ok,
      status,
      data,
      errorMessage: result.ok ? undefined : result.message,
      elapsedMs: Date.now() - started,
    };
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
      const enrichedSummary = buildEscalationIssueSummary(callSid, session, issueSummary);
      const emailResult = await sendSupportEscalation(
        customerName,
        customerEmail,
        session.from,
        enrichedSummary,
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

  if (tool === "dictate_tracking") {
    const gate = resolveDictateTracking(callSid);
    if (gate.intent === "ReadinessRequest") {
      return {
        tool,
        args,
        ok: false,
        status: "blocked",
        data: { intent: "ReadinessRequest", message: gate.speech },
        errorMessage: gate.speech,
        elapsedMs: Date.now() - started,
      };
    }
    if (gate.intent === "unavailable") {
      return {
        tool,
        args,
        ok: false,
        status: "blocked",
        data: { intent: "unavailable", message: gate.speech },
        errorMessage: gate.speech,
        elapsedMs: Date.now() - started,
      };
    }
    return {
      tool,
      args,
      ok: true,
      status: "ok",
      data: {
        intent: "dictate_tracking",
        tracking_number_for_tts: gate.speech,
      },
      elapsedMs: Date.now() - started,
    };
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

    const orderDigits = orderNumber.replace(/\D/g, "");
    if (
      (orderDigits.length === 10 || orderDigits.length === 13) &&
      isValidIsbnFormat(orderDigits)
    ) {
      return {
        tool,
        args: { orderNumber: rawInput },
        ok: false,
        status: "blocked",
        errorMessage:
          "That looks like an ISBN, not an order number. Use search_shopify_book_by_isbn for book catalog lookup.",
        elapsedMs: Date.now() - started,
      };
    }

    logger.info("Executing Shopify Lookup for Normalized Order Number: ", {
      original: rawInput,
      normalized: orderNumber,
    });

    try {
      const callerPhone = session?.callerPhone ?? session?.from ?? "";
      let data: OrderStatusResult;

      if (callerPhone) {
        const aggregated = await aggregateOrderForCaller(orderNumber, callerPhone, callSid);
        if (aggregated.status === "found" && aggregated.order) {
          data = aggregated.order;
          if (session) {
            session.lastOrderStatusResult = data;
            session.isVerifiedCaller = aggregated.is_verified_caller;
            session.callerPhone = callerPhone;
            session.shopifyCustomerPhone = data.customerPhone;
            session.shopifyCustomerId = data.customerId;
            session.totalOrderCount = data.totalOrderCount;
          }
        } else {
          data = {
            status: aggregated.status,
            message: aggregated.message,
            error: aggregated.error,
            searchedNumber: aggregated.searchedNumber ?? orderNumber,
          };
        }
      } else {
        data = await lookupOrderStatus(orderNumber, callSid, {
          bypassCache: true,
        });
        if (session && data.status === "found") {
          session.lastOrderStatusResult = data;
          runVerificationGate(session, data);
        }
      }

      if (isTurnAborted(callSid)) {
        return {
          tool,
          args: { orderNumber },
          ok: false,
          status: "blocked",
          errorMessage: "Turn aborted — tool result discarded",
          elapsedMs: Date.now() - started,
        };
      }
      // After a miss, keep the order-number slot so the next turn bypasses cache
      // and retries live instead of replaying a stale not_found.
      if (session && data.status === "not_found") {
        session.phase = "awaiting_order_number";
        session.awaitingInput = "order_number";
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
      clearOrderStatusCache(orderNumber);
      return {
        tool,
        args: { orderNumber },
        ok: false,
        status: "api_error",
        data: {
          status: "api_error",
          message: "Order lookup temporarily unavailable",
        },
        elapsedMs: Date.now() - started,
      };
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
      if (session && data.status === "found") {
        setOrderHistoryContext(
          session,
          data.orders ?? [],
          data.orderCount ?? data.orders?.length ?? 0,
        );
      }
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
      if (session && data.status === "found") {
        recordLastCatalogSearch(session, data);
        const persistError = await flushSessionAfterCatalogMutation(
          session,
          tool,
          { isbn },
          started,
        );
        if (persistError) return persistError;
      }
      return {
        tool,
        args: { isbn },
        ok: data.status === "found",
        status: data.status,
        data,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : CATALOG_TOOL_ERROR_LLM_PAYLOAD.reason;
      return catalogErrorRecord(tool, { isbn }, started, reason);
    }
  }

  const title = sanitizeCatalogTitlePhrase((args.title ?? "").trim());
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
    if (session && data.status === "found") {
      recordLastCatalogSearch(session, data);
      const persistError = await flushSessionAfterCatalogMutation(
        session,
        tool,
        { title },
        started,
      );
      if (persistError) return persistError;
    }
    return {
      tool,
      args: { title },
      ok: data.status === "found",
      status: data.status,
      data,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : CATALOG_TOOL_ERROR_LLM_PAYLOAD.reason;
    return catalogErrorRecord(tool, { title }, started, reason);
  }
}

/** Compact JSON tool result for the LLM synthesis pass. */
export function toolResultForLlm(
  record: LlmToolExecutionRecord,
  options?: { isVerifiedCaller?: boolean; session?: import("../types/order.js").CallSession },
): string {
  if (record.status === "blocked" || record.status === "invalid_format") {
    if (record.tool === "dictate_tracking" && record.status === "blocked") {
      return JSON.stringify({
        intent:
          record.data && typeof record.data === "object" && "intent" in record.data
            ? record.data.intent
            : "ReadinessRequest",
        message: record.errorMessage,
        instructions:
          "Caller has not confirmed notepad readiness. Speak the readiness request exactly — do NOT dictate the tracking number.",
      });
    }
    const isValidation = record.status === "invalid_format"
      || Boolean(record.errorMessage?.startsWith("Validation Error:"));
    return JSON.stringify({
      error: isValidation ? "validation_error" : "missing_or_invalid_slot",
      message: record.errorMessage,
      hint: isValidation
        ? "Correct the tool arguments or ask the caller for clarification. Do not invent data or retry with the same invalid values."
        : "Ask the caller naturally for the missing information. Do not invent data.",
    });
  }

  if (isMaintenanceToolStatus(record.status)) {
    if (record.errorMessage === "Shopify API timeout" || record.data && "message" in record.data && record.data.message === "Shopify API timeout") {
      return JSON.stringify(SHOPIFY_TIMEOUT_LLM_PAYLOAD);
    }
    if (
      record.errorMessage === SESSION_PERSISTENCE_ERROR_LLM_PAYLOAD.reason ||
      (record.data &&
        "message" in record.data &&
        record.data.message === SESSION_PERSISTENCE_ERROR_LLM_PAYLOAD.reason)
    ) {
      return JSON.stringify(SESSION_PERSISTENCE_ERROR_LLM_PAYLOAD);
    }
    if (
      record.tool === "search_shopify_book_by_title" ||
      record.tool === "search_shopify_book_by_isbn"
    ) {
      if (record.status === "api_error") {
        return JSON.stringify({
          ...CATALOG_TOOL_ERROR_LLM_PAYLOAD,
          reason: record.errorMessage ?? CATALOG_TOOL_ERROR_LLM_PAYLOAD.reason,
        });
      }
    }
    if (record.tool === "get_shopify_order_status") {
      return JSON.stringify(ORDER_LOOKUP_MAINTENANCE_LLM_PAYLOAD);
    }
    return JSON.stringify(SYSTEM_MAINTENANCE_LLM_PAYLOAD);
  }

  if (
    record.status === "api_error" &&
    (record.errorMessage === "Shopify API timeout" ||
      (record.data &&
        "message" in record.data &&
        record.data.message === "Shopify API timeout"))
  ) {
    return JSON.stringify(SHOPIFY_TIMEOUT_LLM_PAYLOAD);
  }

  if (record.data && "status" in record.data && isMaintenanceToolStatus(record.data.status)) {
    if (record.tool === "get_shopify_order_status") {
      return JSON.stringify(ORDER_LOOKUP_MAINTENANCE_LLM_PAYLOAD);
    }
    return JSON.stringify(SYSTEM_MAINTENANCE_LLM_PAYLOAD);
  }

  if (record.tool === "dictate_tracking") {
    const blocked = !record.ok;
    const readiness =
      blocked && record.data && "intent" in record.data && record.data.intent === "ReadinessRequest";
    return JSON.stringify({
      intent: readiness ? "ReadinessRequest" : "dictate_tracking",
      message: record.errorMessage ?? (record.data && "message" in record.data ? record.data.message : undefined),
      tracking_number_for_tts:
        !blocked && record.data && "tracking_number_for_tts" in record.data
          ? record.data.tracking_number_for_tts
          : null,
      instructions: readiness
        ? "NOTEPAD-FIRST RULE: Speak ONLY the readiness handshake verbatim — 'I have your tracking number right here. Let me know when you have a pen and paper ready.' Do NOT read any tracking digits."
        : "DICTATION PROTOCOL: Speak tracking_number_for_tts digit-by-digit with PAUSES only — spoken words like 'Nine... Four... Four... Nine... Zero... One.' NEVER use commas, hyphens, or dashes (TTS will say those words aloud). Append 'Did you get all that, or should I repeat any part of it?' Never mention items, fees, payment, or other order fields. On 'repeat that' / 'say it slower', re-speak ONLY tracking_number_for_tts even slower — never the full order. If the caller asks What comes after [Number]?, locate that number and read ONLY the digits after it. If the caller confirms they wrote it down, stop dictating and ask if they need anything else.",
    });
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
    record.tool === "update_cart_item_quantity" ||
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
        'Say: "I have sent the secure payment link to your inbox. Once you open it, you will be able to enter your loved one\'s specific Inmate Facility details and complete your purchase securely. Is there anything else I can help you with?" (Short form OK: "I am sending the payment link to your email now. Is there anything else I can help you with?") then WAIT — do NOT invoke end_call, say goodbye, or send another link unless they ask to resend.',
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

  if (record.tool === "update_pending_email") {
    return JSON.stringify({
      status: record.status,
      ok: record.ok,
      result: record.data,
      error: record.errorMessage,
      instructions: record.ok
        ? "Apologize if needed, speak spelled_for_tts letter-by-letter with pauses (B, A, S, H — never 'A as in Apple'), then ask if that is correct."
        : "Ask the caller to repeat the full email slowly.",
    });
  }

  if (record.tool === "end_call") {
    return JSON.stringify({
      status: "ok",
      ok: true,
      instructions: `Say exactly: "${SURESHOT_GOODBYE_SPEECH}" The call will end immediately after you speak.`,
    });
  }

  if (record.tool === "search_shopify_book_by_title") {
    const data = record.data as BookAvailabilityResult;
    const suppressEscalation = shouldSuppressCatalogEscalation(options?.session);
    const notFoundInstruction = suppressEscalation
      ? "Apologize that the exact book was not found. Offer to try a different title or ISBN. Do NOT escalate to support unless the customer explicitly asks for human help or a warehouse check."
      : "Follow OMNI-CHANNEL ESCALATION S.O.P.: ask for email, verify letter-by-letter, call send_support_escalation, then say: I have sent your request to the support team. They will contact you shortly.";
    if (data.status === "not_found") {
      return JSON.stringify({
        status: "NOT_FOUND",
        queriedTitle: data.queriedTitle,
        instructions: notFoundInstruction,
      });
    }
    const similar = data.similarMatches ?? [];
    const volumeHint =
      data.exactMatch === true
        ? "EXACT MATCH: Say confidently: 'I found exactly what you are looking for: [bookName] for [price].' Follow ZERO ASSUMPTION QUANTITY — ask how many copies before update_cart_item_quantity unless the caller already stated a quantity."
        : data.exactMatch === false && similar.length > 1
          ? "No exact match. Say: 'I don't have that exact book, but I found these similar options...' Read the top 2 or 3 entries from similarMatches (bookName, inStock, price) and ask if they want one. Follow ZERO ASSUMPTION QUANTITY before update_cart_item_quantity."
          : suppressEscalation
            ? "If in stock, offer to add to cart using update_cart_item_quantity with action_type=add and variant_id/unit_price from this response — follow ZERO ASSUMPTION QUANTITY. If out of stock, apologize and offer similar titles — do NOT escalate unless they ask for support."
            : "If in stock, offer to add to cart using update_cart_item_quantity with action_type=add and variant_id/unit_price from this response — follow ZERO ASSUMPTION QUANTITY and ask how many copies unless quantity was already stated. If out of stock, follow OMNI-CHANNEL ESCALATION S.O.P.";
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

    const verified = options?.isVerifiedCaller === true;
    const payload = {
      status: "FOUND",
      found: true,
      data: filterOrderContextForVerification(
        shapeOrderStatusForLlm(record.data, undefined, verified) as ActiveOrderContextData,
        verified,
      ),
      instructions:
        "SECURITY CLEARANCE (UNBREAKABLE RULE): If isVerifiedCaller is FALSE, you are ONLY forbidden from sharing two things: (1) the exact Shipping Address, and (2) Past Order History / previous months' orders. You MUST share EVERYTHING ELSE — Item Names, Item Prices, Quantities, Subtotal, Taxes, Shipping Fees, Total Amount, Payment Method, Notification Emails, and Timeline Events. Do not apologize; simply provide the info. ABSOLUTE BLACKLIST: shipping_address and past_order_history only. UNVERIFIED CALLER PERMISSIONS: RESTRICTED = Shipping Address + Full Order History; ALLOWED = everything else — never say Sorry I can't for allowed items. CONVERSATION LOCK: Once an order is FOUND, you are LOCKED to this order — NEVER re-invoke get_shopify_order_status for follow-ups. If the user provides digits (e.g. What comes after 47 / 80111 / 48011), assume they are clarifying Tracking ID or the order already in memory — NOT a new search. Locate digits in tracking_number_for_tts/spatialIndex and read only the remainder. PASSIVE CONFIRMATION: On FOUND do not dump status/items/totals/emails — the spoken confirmation is already handled; answer only what they ask next. EXPLAINING PAYMENTS & NOTIFICATIONS: Act like a human concierge when asked. If financial_status is PAID and card last4 is null, explain via sourceName / Litextension when present. For notification routing say notifications were routed to the contact on file when asked. If tracking is in orderNote, say you found tracking securely noted, then dictate. Never invent vague lockdowns from privacy_tier wording. Translate events via THE SHOPIFY BRAIN — never read events verbatim and never speak staff names. physical_items and item_count are BOOKS ONLY. Keys always present: customer_name, customer_email, payment_method, payment_method_last4, card_brand, cancel_reason, refund_reason, refund_notification_email, order_confirmation_email (null when absent — never invent). LEGACY DATA: If tracking_number is null, scan orderNote/note for Tracking Number. For tracking dictation use pause-only spoken digits (Nine... Four... Four... Nine... Zero... One). Never end_call for missing fields.",
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
        ? (() => {
            const isbnData = record.data as BookAvailabilityResult;
            if (isbnData.status === "found" && isbnData.inStock === false) {
              return `Say exactly: "${OUT_OF_STOCK_ISBN_MESSAGE}" Then offer warehouse follow-up via OMNI-CHANNEL ESCALATION S.O.P. if they want storage checked.`;
            }
            return "If in stock, offer to add to cart using variant_id and unit_price (from the price field) from this response. If out of stock, follow GRACEFUL ESCALATION.";
          })()
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

function buildEscalationIssueSummary(
  callSid: string,
  session: CallSession,
  userSummary: string,
): string {
  const issue = userSummary.trim() || "Voice support request";
  const orderNumber = String(session.currentOrderData?.order_number ?? "").trim();
  const verified = session.isVerifiedCaller === true ? "verified" : "unverified";
  const parts = [issue, `Caller ${session.from}`, `${verified} line`];
  if (orderNumber) parts.push(`Order ${orderNumber}`);
  return parts.join(" | ");
}

/** Keys that must always exist on session.currentOrderData / LLM payloads (null allowed). */
export const OMNI_EXTRACTOR_PAYLOAD_KEYS = [
  "customer_name",
  "payment_method",
  "payment_method_last4",
  "card_brand",
  "cancel_reason",
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
 * Includes public_data (safe for unverified) and secure_data (verified only).
 * Omni-Extractor keys are always present on the flat payload — never dropped.
 */
function shapeOrderStatusForLlm(
  data: OrderStatusResult,
  session?: CallSession,
  verifiedOverride?: boolean,
): Record<string, unknown> {
  const trackingNumber =
    data.trackingNumber && isValidTrackingNumber(data.trackingNumber)
      ? normalizeTrackingIdRawSequence(data.trackingNumber)
      : null;
  const refundNotificationEmail =
    data.refundNotificationEmail ??
    data.refundEmail ??
    extractRefundNotificationEmailFromMessages(
      Array.isArray(data.events) ? data.events.map(String) : [],
    ) ??
    null;
  const orderConfirmationEmail = data.orderConfirmationEmail ?? null;
  const verified = verifiedOverride ?? session?.isVerifiedCaller === true;
  const paymentMethod =
    formatPaymentMethodLabel(data.cardBrand, data.cardLast4, data.paymentGateway) ?? null;
  const cancelReason = data.cancelReason ?? data.refundReason ?? null;
  const { physicalItems, feeItems } = splitLineItems(data.lineItems ?? []);
  const itemCount = physicalItemCount(data.lineItems ?? []);
  const processingFees = feeItems.filter((line) => /\bfee\b/i.test(line.title));
  const shippingFees = feeItems.filter((line) => /\bshipping\b/i.test(line.title));
  const handlingFees = feeItems.filter((line) => /\bhandling\b/i.test(line.title));

  const publicItems = physicalItems.map((item) => {
    const row = item as {
      title: string;
      quantity: number;
      variantTitle?: string;
      fulfillmentStatus?: string;
      price?: string;
      originalUnitPrice?: string;
    };
    const price = row.price ?? row.originalUnitPrice;
    return {
      title: row.title,
      quantity: row.quantity,
      ...(price ? { price } : {}),
      ...(row.variantTitle ? { variant_title: row.variantTitle } : {}),
      ...(row.fulfillmentStatus ? { fulfillment_status: row.fulfillmentStatus } : {}),
    };
  });

  const publicData: Record<string, unknown> = {
    order_number: data.orderNumber ?? null,
    fulfillment_status: data.fulfillmentStatus ?? null,
    financial_status: data.financialStatus ?? null,
    tracking_number: trackingNumber,
    tracking_company: data.trackingCompany ?? null,
    tracking_url: data.trackingUrl ?? null,
    tracking_status: data.trackingStatus ?? null,
    estimated_delivery_days: data.estimatedDeliveryDays ?? null,
    estimated_delivery_date: data.estimatedDeliveryDate ?? null,
    shipping_timeframe:
      typeof data.estimatedDeliveryDays === "number"
        ? data.estimatedDeliveryDays <= 0
          ? "Delivered or shipping today"
          : `About ${data.estimatedDeliveryDays} day(s)`
        : null,
    item_count: itemCount,
    physical_items: publicItems.length ? publicItems : null,
    // Whitelist fields available to unverified callers (see SECURITY OVERRIDE).
    customer_name: data.customerName ?? null,
    customer_email: data.customerEmail ?? null,
    customer_email_for_tts: formatEmailForTTS(data.customerEmail ?? null),
    total_amount: data.totalAmount ?? null,
    shipping_amount: data.shippingFee ?? null,
    subtotal_amount: data.subtotalAmount ?? null,
    total_tax: data.totalTax ?? null,
    refund_notification_email: refundNotificationEmail,
    refund_notification_email_for_tts: formatEmailForTTS(refundNotificationEmail),
    order_confirmation_email: orderConfirmationEmail,
    order_confirmation_email_for_tts: formatEmailForTTS(orderConfirmationEmail),
    events: data.events ?? [],
    note: data.orderNote ?? null,
    order_note: data.orderNote ?? null,
    tags: data.tags ?? [],
    metafields: data.metafields ?? [],
    payment_method: paymentMethod,
    payment_method_last4: data.cardLast4 ?? null,
    payment_gateway: data.paymentGateway ?? null,
    card_brand: data.cardBrand ?? null,
    refund_status: data.refundStatus ?? null,
    refund_reason: data.refundReason ?? null,
    cancel_reason: cancelReason,
    refund_amount: data.refundAmount ?? null,
    source_name: data.sourceName ?? null,
    transactions: data.transactions ?? [],
    fee_items: feeItems.length ? feeItems : null,
    processing_fees: processingFees.length ? processingFees : null,
    shipping_fees: shippingFees.length ? shippingFees : null,
    handling_fees: handlingFees.length ? handlingFees : null,
    total_discounts: data.totalDiscounts ?? null,
  };

  const secureData: Record<string, unknown> | null = verified
    ? {
        customer_name: data.customerName ?? null,
        customer_email: data.customerEmail ?? null,
        customer_email_for_tts: formatEmailForTTS(data.customerEmail ?? null),
        customer_phone: data.customerPhone ?? null,
        shipping_address: data.shippingAddress ?? null,
        past_order_history: data.pastOrderHistory ?? [],
        total_order_count: data.totalOrderCount ?? session?.totalOrderCount ?? null,
        physical_items: physicalItems.length ? physicalItems : null,
        fee_items: feeItems.length ? feeItems : null,
        processing_fees: processingFees.length ? processingFees : null,
        shipping_fees: shippingFees.length ? shippingFees : null,
        handling_fees: handlingFees.length ? handlingFees : null,
        total_amount: data.totalAmount ?? null,
        shipping_amount: data.shippingFee ?? null,
        subtotal_amount: data.subtotalAmount ?? null,
        total_tax: data.totalTax ?? null,
        total_discounts: data.totalDiscounts ?? null,
        payment_method: paymentMethod,
        payment_method_last4: data.cardLast4 ?? null,
        payment_gateway: data.paymentGateway ?? null,
        card_brand: data.cardBrand ?? null,
        refund_status: data.refundStatus ?? null,
        refund_reason: data.refundReason ?? null,
        cancel_reason: cancelReason,
        refund_amount: data.refundAmount ?? null,
        refund_notification_email: refundNotificationEmail,
        refund_notification_email_for_tts: formatEmailForTTS(refundNotificationEmail),
        order_confirmation_email: orderConfirmationEmail,
        order_confirmation_email_for_tts: formatEmailForTTS(orderConfirmationEmail),
        events: data.events ?? [],
        note: data.orderNote ?? null,
        order_note: data.orderNote ?? null,
        tags: data.tags ?? [],
        metafields: data.metafields ?? [],
        source_name: data.sourceName ?? null,
        channel_name: data.channelName ?? null,
        publication_name: data.publicationName ?? null,
        is_draft_order_origin: data.isDraftOrderOrigin === true,
        custom_attributes: data.customAttributes ?? [],
        transactions: data.transactions ?? [],
        order_placed_at: data.orderPlacedAt ?? null,
        refund_date: data.refundDate ?? null,
      }
    : null;

  const payload: Record<string, unknown> = {
    public_data: publicData,
    secure_data: secureData,
    order_number: data.orderNumber ?? null,
    customer_name: data.customerName ?? null,
    customer_email: data.customerEmail ?? null,
    customer_email_for_tts: formatEmailForTTS(data.customerEmail ?? null),
    is_verified_caller: verified,
    total_order_count: verified
      ? (data.totalOrderCount ?? session?.totalOrderCount ?? null)
      : null,
    shipping_address: verified ? (data.shippingAddress ?? null) : null,
    past_order_history: verified ? (data.pastOrderHistory ?? []) : null,
    physical_items: publicItems.length ? publicItems : null,
    fee_items: feeItems.length ? feeItems : null,
    item_count: itemCount,
    items: publicItems.length ? publicItems : null,
    processing_fees: processingFees.length ? processingFees : null,
    shipping_fees: shippingFees.length ? shippingFees : null,
    handling_fees: handlingFees.length ? handlingFees : null,
    total_amount: data.totalAmount ?? null,
    shipping_amount: data.shippingFee ?? null,
    subtotal_amount: data.subtotalAmount ?? null,
    total_tax: data.totalTax ?? null,
    total_discounts: data.totalDiscounts ?? null,
    payment_method: paymentMethod,
    payment_method_last4: data.cardLast4 ?? null,
    payment_gateway: data.paymentGateway ?? null,
    card_brand: data.cardBrand ?? null,
    refund_status: data.refundStatus ?? null,
    refund_reason: data.refundReason ?? null,
    cancel_reason: cancelReason,
    refund_amount: data.refundAmount ?? null,
    refund_notification_email: refundNotificationEmail,
    refund_notification_email_for_tts: formatEmailForTTS(refundNotificationEmail),
    order_confirmation_email: orderConfirmationEmail,
    order_confirmation_email_for_tts: formatEmailForTTS(orderConfirmationEmail),
    events: data.events ?? [],
    note: data.orderNote ?? null,
    order_note: data.orderNote ?? null,
    tags: data.tags ?? [],
    metafields: data.metafields ?? [],
    source_name: data.sourceName ?? null,
    channel_name: data.channelName ?? null,
    publication_name: data.publicationName ?? null,
    is_draft_order_origin: data.isDraftOrderOrigin === true,
    custom_attributes: data.customAttributes ?? [],
    transactions: data.transactions ?? [],
    order_placed_at: data.orderPlacedAt ?? null,
    refund_date: data.refundDate ?? null,
    fulfillment_status: data.fulfillmentStatus ?? null,
    financial_status: data.financialStatus ?? null,
    estimated_delivery_days: data.estimatedDeliveryDays ?? null,
    estimated_delivery_date: data.estimatedDeliveryDate ?? null,
    tracking_number: trackingNumber,
    tracking_company: data.trackingCompany ?? null,
    tracking_url: data.trackingUrl ?? null,
    tracking_number_for_tts: trackingNumber
      ? formatTrackingNumberForTTS(trackingNumber)
      : null,
    tracking_status: data.trackingStatus ?? null,
    privacy_tier: verified ? "verified" : "unverified",
    vault_access: verified ? "granted" : "restricted",
  };

  // Payload synchronization guard — these keys must never be omitted.
  for (const key of OMNI_EXTRACTOR_PAYLOAD_KEYS) {
    if (!(key in payload)) {
      payload[key] = null;
    }
  }

  return payload;
}
