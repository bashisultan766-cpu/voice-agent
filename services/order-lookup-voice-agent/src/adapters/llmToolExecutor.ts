/**
 * Executes OpenAI tool calls against Shopify with zero-hallucination validation.
 */
import {
  getCustomerHistory,
  type BookAvailabilityResult,
  type CustomerHistoryResult,
} from "./shopifyStorefrontAdapter.js";
import { searchByISBN, searchByTitle } from "../infra/shopifyQueryBoundary.js";
import { clearOrderStatusCache } from "../services/shopifyService.js";
import {
  getCartSummary,
  type CheckoutItemSelector,
} from "../agents/cartManager.js";
import { recordLastCatalogSearch, reconcileAddToCartItems } from "../agents/catalogTarget.js";
import { shouldSuppressCatalogEscalation } from "../agents/agentBrain.js";
import { getSessionMemory } from "../agents/sessionMemory.js";
import {
  applySessionCartQuantity,
  confirmPendingCartRemoval,
  shouldBlockOrderLookupReinvoke,
} from "../agents/orderLookupWorkflow.js";
import { normalizeTrackingIdRawSequence } from "../utils/trackingIdSequence.js";
import type { CallSession } from "../types/order.js";
import {
  validateShopifyExecutionGate,
  sanitizeCatalogTitlePhrase,
  type EntityExtractionResult,
} from "../nlp/entityExtractor.js";
import { normalizeIsbn, isValidIsbnFormat } from "../utils/productSearchNormalize.js";
import { parseVariantGid } from "../utils/shopifyGid.js";
import { getAgentState } from "../platform/eventDispatcher.js";
import { setOrderHistoryContext } from "../agents/orderHistoryFlow.js";
import { lookupOrderForCaller, type CallerOrderLookupResult } from "../agents/orderLookupService.js";
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
import { getActiveOrderContext } from "../agents/sessionManager.js";

function isCheckoutItemSelector(entry: CheckoutItemSelector | null): entry is CheckoutItemSelector {
  return entry !== null;
}

/** Map unpredictable LLM checkout item payloads into strict CheckoutItemSelector[]. */
function normalizeCheckoutItemArgs(args: Record<string, unknown>): CheckoutItemSelector[] | null {
  const fromItems = Array.isArray(args.items)
    ? args.items
    : Array.isArray(args.sku_list)
      ? args.sku_list
      : Array.isArray(args.skuList)
        ? args.skuList
        : null;
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
      const positionRaw = Number(row.position ?? row.cart_index ?? row.cartIndex);
      const hasPosition = Number.isFinite(positionRaw) && positionRaw >= 1;
      if (!variantIdRaw && !title && !hasPosition) return null;

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
        position: hasPosition ? Math.floor(positionRaw) : undefined,
        cart_index: hasPosition ? Math.floor(positionRaw) : undefined,
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
  /** Latest caller utterance — used by TerminationCoordinator for end_call. */
  userMessage?: string;
}

export type LlmToolName =
  | "get_shopify_order_status"
  | "get_customer_history"
  | "search_shopify_book_by_isbn"
  | "search_shopify_book_by_title"
  | "dictate_tracking"
  | "update_cart_item_quantity"
  | "get_cart_summary"
  | "check_logistics_feasibility"
  | "verify_stock_availability"
  | "initiate_checkout_batch"
  | "send_checkout_email"
  | "create_support_case"
  | "update_pending_email"
  | "escalate_to_human"
  | "end_call";

/** Aliases the LLM may emit — always resolve to the canonical tool name. */
const LLM_TOOL_ALIASES: Record<string, LlmToolName> = {
  generate_payment_link: "send_checkout_email",
  send_payment_link: "send_checkout_email",
  update_cart_quantity: "update_cart_item_quantity",
  add_to_cart: "update_cart_item_quantity",
  partial_correction: "update_pending_email",
  escalate_to_human_agent: "escalate_to_human",
  send_support_escalation: "create_support_case",
};

export function normalizeLlmToolName(name: string): LlmToolName | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  if (trimmed in LLM_TOOL_ALIASES) return LLM_TOOL_ALIASES[trimmed]!;
  const canonical: LlmToolName[] = [
    "get_shopify_order_status",
    "get_customer_history",
    "search_shopify_book_by_isbn",
    "search_shopify_book_by_title",
    "dictate_tracking",
    "update_cart_item_quantity",
    "get_cart_summary",
    "check_logistics_feasibility",
    "verify_stock_availability",
    "initiate_checkout_batch",
    "send_checkout_email",
    "create_support_case",
    "update_pending_email",
    "escalate_to_human",
    "end_call",
  ];
  return (canonical as string[]).includes(trimmed) ? (trimmed as LlmToolName) : null;
}

export interface CartToolResult {
  status:
    | "ok"
    | "empty"
    | "error"
    | "confirm_removal"
    | "compliance_blocked"
    | "inventory_blocked";
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
  currentSessionCart?: Record<string, number>;
  needsRemovalConfirmation?: boolean;
  confirmationSpeech?: string;
  complianceBlocked?: boolean;
  needsFacilityInfo?: boolean;
  inventoryBlocked?: boolean;
  suggestAlternatives?: boolean;
  temporaryReservation?: boolean;
  inventoryQuantity?: number;
  proactiveRecommendation?: {
    title: string;
    variantId: string;
    matchReason?: string;
    speech?: string;
  };
}

export interface CheckoutEmailToolResult {
  status: "sent" | "failed" | "error" | "blocked";
  invoice_url?: string;
  invoiceUrl?: string;
  draft_order_name?: string;
  reason?: string;
  message?: string;
  instructions?: string;
  splitBatch?: boolean;
  remainingCartUnits?: number;
  checkoutGroupId?: string;
  confirmedEmailId?: string;
  checkoutSession?: {
    phase: string;
    remainingItems: Array<{ title: string; quantity: number; variantId: string }>;
    currentBatch: Array<{ title: string; quantity: number; variantId: string }>;
    completedBatches: number;
    batchNumber: number;
  };
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

export interface PendingEmailToolResult {
  status: "ok" | "blocked";
  message?: string;
  confirmationSpeech?: string;
  pendingEmailSlots?: {
    full: string;
    part1: string;
    part2: string;
    domain: string;
  };
  partialCorrection?: {
    slot: string;
    from: string;
    to: string;
  };
  instructions?: string;
}

export interface EscalateToHumanToolResult {
  status: "ok" | "blocked";
  message?: string;
  ticketId?: string;
  instructions?: string;
}

export interface LogisticsToolResult {
  status?: "ok" | "blocked";
  shipable?: boolean;
  title?: string;
  reason?: string;
  message?: string;
}

export interface StockVerifyToolResult {
  status?: "ok" | "blocked";
  cartUpdated?: boolean;
  removedTitles?: string[];
  lines?: unknown[];
  viableSelectors?: unknown[];
  message?: string;
  currentSessionCart?: Record<string, number>;
}

export interface InitiateCheckoutBatchToolResult {
  status?: "ok" | "blocked";
  message?: string;
  remainingUnits?: number;
  cartUpdated?: boolean;
  stockVerified?: boolean;
  instructions?: string;
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
    | "failed"
    | "confirm_removal"
    | "compliance_blocked"
    | "inventory_blocked";
  data?:
    | CallerOrderLookupResult
    | CustomerHistoryResult
    | BookAvailabilityResult
    | CartToolResult
    | CheckoutEmailToolResult
    | SupportEscalationToolResult
    | DictateTrackingToolResult
    | PendingEmailToolResult
    | EscalateToHumanToolResult
    | LogisticsToolResult
    | StockVerifyToolResult
    | InitiateCheckoutBatchToolResult;
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
  const canonicalTool = normalizeLlmToolName(tool) ?? tool;

  let effectiveArgs = rawArgs ?? {};
  let effectiveSession = session;
  if (!options?.skipPolicy) {
    const prepared = prepareUnifiedToolArgs(canonicalTool, effectiveArgs, callSid, effectiveSession);
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
  tool = canonicalTool;

  if (tool === "end_call") {
    if (session) {
      const { TerminationCoordinator } = await import("../runtime/terminationCoordinator.js");
      const decision = TerminationCoordinator.evaluate(
        session,
        "llm_end_call",
        options?.userMessage ?? "",
      );
      if (!decision.allow) {
        return {
          tool,
          args,
          ok: false,
          status: "blocked",
          errorMessage: decision.speech ?? decision.blockReason ?? "end_call blocked",
          data: {
            status: "blocked",
            message: decision.speech,
            instructions: "Continue helping — hang-up only after explicit goodbye.",
          },
          elapsedMs: Date.now() - started,
        };
      }
    }
    return {
      tool,
      args,
      ok: true,
      status: "ok",
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "escalate_to_human") {
    const { SENTIMENT_SHIELD_SPEECH } = await import("../utils/sentiment.js");
    const { ESCALATION_FAILURE_SPEECH } = await import("../agents/flowMutex.js");
    if (!session) {
      return {
        tool,
        args,
        ok: false,
        status: "blocked",
        errorMessage: "Session unavailable for human escalation.",
        elapsedMs: Date.now() - started,
      };
    }
    const reason = String(args.reason ?? "agent_requested").trim() || "agent_requested";
    const { ActionGateway } = await import("../runtime/actionGateway.js");
    const result = await ActionGateway.escalateToHuman(session, reason, {
      callId: session.callSid,
      actionId: `escalate_${Date.now().toString(36)}`,
      workflowId: "llm_tool",
    });
    if (!result.ok) {
      return {
        tool,
        args: { reason },
        ok: false,
        status: "error",
        errorMessage: result.error,
        data: {
          status: "error",
          message: result.speech ?? ESCALATION_FAILURE_SPEECH,
          instructions: `Speak exactly: ${result.speech ?? ESCALATION_FAILURE_SPEECH}`,
        },
        elapsedMs: Date.now() - started,
      };
    }
    const ticketId = result.caseId ?? "";
    return {
      tool,
      args: { reason, ticketId },
      ok: true,
      status: "ok",
      data: {
        status: "ok",
        message: `Escalated to human agent (${ticketId}).`,
        ticketId,
        instructions: `Speak Support-Mode: ${SENTIMENT_SHIELD_SPEECH}`,
      },
      elapsedMs: Date.now() - started,
    };
  }

  if (!session && (
    tool === "update_cart_item_quantity" ||
    tool === "get_cart_summary" ||
    tool === "check_logistics_feasibility" ||
    tool === "verify_stock_availability" ||
    tool === "initiate_checkout_batch" ||
    tool === "send_checkout_email" ||
    tool === "create_support_case" ||
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
    const { buildUpdatedEmailConfirmationSpeech } = await import("../utils/emailCapture.js");
    const email = (args.email ?? args.customerEmail ?? "").trim();
    const replaceFrom = String(args.replace_from ?? args.replaceFrom ?? "").trim();
    const replaceTo = String(args.replace_to ?? args.replaceTo ?? "").trim();
    const slotRaw = String(args.slot ?? args.email_slot ?? "").trim().toLowerCase();
    const slot =
      slotRaw === "part1" || slotRaw === "part2" || slotRaw === "domain" || slotRaw === "local"
        ? slotRaw
        : undefined;
    const baseEmail =
      email ||
      session.emailConfirmation?.normalizedEmail ||
      "";
    const result = updatePendingEmail(session, baseEmail, email || baseEmail, {
      replaceFrom: replaceFrom || undefined,
      replaceTo: replaceTo || undefined,
      slot,
    });
    if (!result.ok) {
      const failArgs: Record<string, string> = { email: baseEmail };
      if (replaceFrom) failArgs.replace_from = replaceFrom;
      if (replaceTo) failArgs.replace_to = replaceTo;
      return {
        tool,
        args: failArgs,
        ok: false,
        status: "blocked",
        errorMessage: result.error,
        elapsedMs: Date.now() - started,
      };
    }
    const confirmSpeech = buildUpdatedEmailConfirmationSpeech(result.email, result.correction);
    return {
      tool,
      args: { email: result.email },
      ok: true,
      status: "ok",
      data: {
        status: "ok",
        message: `Pending email updated to ${result.email}. spelled_for_tts: ${result.spelled}`,
        confirmationSpeech: confirmSpeech,
        pendingEmailSlots: result.pending,
        partialCorrection: result.correction,
        instructions:
          "SEMANTIC SLOT REPAIR: Speak the confirmationSpeech verbatim (acknowledge the corrected slot only, then verify the full updated email). Do NOT re-ask for the entire address.",
      } satisfies PendingEmailToolResult,
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
      const confirmRemoval =
        rawArgsForCart.confirm_removal === true ||
        rawArgsForCart.confirmRemoval === true ||
        actionRaw === "confirm_remove";
      const facilityType = String(
        rawArgsForCart.facility_type ??
          rawArgsForCart.facilityType ??
          session.facilityType ??
          "",
      ).trim();

      if ((confirmRemoval || actionRaw === "keep") && session.pendingCartRemoval) {
        const confirmed = confirmPendingCartRemoval(session, actionRaw !== "keep");
        if (confirmed) {
          const data: CartToolResult = {
            status: "ok",
            items: confirmed.cart.map((line) => ({
              title: line.title,
              quantity: line.quantity,
              variant_id: line.variantId,
              product_id: line.productId,
              unit_price: line.unitPrice ?? line.price,
              price: line.unitPrice ?? line.price,
            })),
            total_units: confirmed.cart.reduce((sum, line) => sum + line.quantity, 0),
            message: confirmed.message,
            currentSessionCart: confirmed.currentSessionCart,
          };
          return { tool, args, ok: true, status: "ok", data, elapsedMs: Date.now() - started };
        }
      }

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
            "Provide item_id/variant_id/sku or title, plus quantity and action_type (add | set | minus | set_exact | remove).",
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

      const actionForEngine =
        rawArgsForCart.set_absolute_quantity === true ? "set" : actionRaw || "add";

      let lastResult = applySessionCartQuantity(
        session,
        items[0]!,
        Number(items[0]!.quantity ?? rawArgsForCart.quantity ?? 1) || 1,
        actionForEngine,
        { confirmRemoval, facilityType: facilityType || undefined },
      );
      for (let i = 1; i < items.length; i++) {
        const item = items[i]!;
        const quantity = Number(item.quantity ?? rawArgsForCart.quantity ?? 1) || 1;
        lastResult = applySessionCartQuantity(session, item, quantity, actionForEngine, {
          confirmRemoval,
          facilityType: facilityType || undefined,
        });
        if (lastResult.needsRemovalConfirmation || lastResult.complianceBlocked || lastResult.inventoryBlocked)
          break;
      }

      const cart = lastResult.cart;
      const data: CartToolResult = {
        status: lastResult.complianceBlocked
          ? "compliance_blocked"
          : lastResult.inventoryBlocked
            ? "inventory_blocked"
            : lastResult.needsRemovalConfirmation
              ? "confirm_removal"
              : "ok",
        items: cart.map((line) => ({
          title: line.title,
          quantity: line.quantity,
          variant_id: line.variantId,
          product_id: line.productId,
          unit_price: line.unitPrice ?? line.price,
          price: line.unitPrice ?? line.price,
        })),
        total_units: cart.reduce((sum, line) => sum + line.quantity, 0),
        message: lastResult.message,
        currentSessionCart: lastResult.currentSessionCart,
        needsRemovalConfirmation: lastResult.needsRemovalConfirmation,
        confirmationSpeech: lastResult.confirmationSpeech ?? lastResult.message,
        complianceBlocked: lastResult.complianceBlocked,
        needsFacilityInfo: lastResult.needsFacilityInfo,
        inventoryBlocked: lastResult.inventoryBlocked,
        suggestAlternatives: lastResult.suggestAlternatives,
        temporaryReservation: lastResult.temporaryReservation,
        inventoryQuantity: lastResult.inventoryQuantity,
        proactiveRecommendation: lastResult.proactiveRecommendation,
      };
      return {
        tool,
        args,
        ok: !lastResult.complianceBlocked && !lastResult.inventoryBlocked,
        status: data.status,
        data,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("cart_tool_execution_failed", {
        callSid: session.callSid.slice(0, 8),
        reason,
      });
      return {
        ...cartErrorRecord(tool, args, started),
        errorMessage: `Cart update failed: ${reason}`,
      };
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

  if (tool === "check_logistics_feasibility" && session) {
    const { checkLogisticsFeasibility, gateBatchForLogistics } = await import(
      "../agents/logisticsIntelligence.js"
    );
    const facilityType = String(args.facility_type ?? args.facilityType ?? session.facilityType ?? "").trim();
    const sku = String(args.sku ?? args.variant_id ?? args.variantId ?? "").trim();
    const title = String(args.title ?? "").trim();
    const cart = getCartSummary(session).items;
    const line =
      cart.find(
        (l) =>
          (sku && (l.variantId === sku || l.isbn === sku)) ||
          (title && l.title.toLowerCase() === title.toLowerCase()),
      ) ?? undefined;

    if (line || title || sku) {
      const result = checkLogisticsFeasibility(
        {
          title: line?.title ?? (title || "that book"),
          variantId: line?.variantId ?? sku,
          sku,
          tags: line?.tags ?? (Array.isArray(args.tags) ? (args.tags as string[]) : undefined),
          metafields:
            line?.metafields ??
            (Array.isArray(args.metafields)
              ? (args.metafields as Array<{ namespace: string; key: string; value: string }>)
              : undefined),
        },
        facilityType,
      );
      if (!result.ok && line) {
        gateBatchForLogistics(
          session,
          [{ variant_id: line.variantId, title: line.title, quantity: line.quantity }],
          facilityType,
        );
      }
      return {
        tool,
        args,
        ok: result.ok,
        status: result.ok ? "ok" : "blocked",
        data: {
          shipable: result.shipable,
          title: result.title,
          reason: result.reason,
          message: result.speech ?? (result.ok ? "Shipable to facility." : "Not shipable."),
        },
        elapsedMs: Date.now() - started,
      };
    }

    return {
      tool,
      args,
      ok: false,
      status: "blocked",
      errorMessage: "Provide sku/variant_id or title for logistics check.",
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "verify_stock_availability" && session) {
    const { verifyStockAvailability } = await import("../agents/logisticsIntelligence.js");
    const { resolveInventoryBatch } = await import("../agents/inventoryResolutionService.js");
    const skuList = normalizeCheckoutItemArgs(args) ?? undefined;
    const liveRaw = args.live_inventory ?? args.liveInventory;
    let liveInventory =
      liveRaw && typeof liveRaw === "object"
        ? (liveRaw as Record<string, number>)
        : undefined;
    let inventoryUnavailable = false;
    if (!liveInventory) {
      const { resolveCheckoutLineItems } = await import("../agents/cartManager.js");
      const resolved = resolveCheckoutLineItems(session, skuList);
      if (resolved.ok) {
        const requests = resolved.items
          .map((line) => ({
            variantId: line.variantId,
            requestedQuantity: Math.max(1, line.quantity || 1),
          }))
          .filter((r) => r.variantId);
        const resolutions = await resolveInventoryBatch(session, requests, { force: true });
        liveInventory = {};
        inventoryUnavailable = resolutions.some((r) => r.availableQuantity == null);
        for (const r of resolutions) {
          if (r.availableQuantity != null) {
            liveInventory[r.variantId] = r.availableQuantity;
          }
        }
      }
    }
    const result = verifyStockAvailability(session, skuList, {
      liveInventory,
      inventoryUnavailable,
    });
    return {
      tool,
      args,
      ok: result.ok,
      status: result.ok ? "ok" : "blocked",
      data: {
        cartUpdated: result.cartUpdated,
        removedTitles: result.removedTitles,
        lines: result.lines,
        viableSelectors: result.viableSelectors,
        message: result.speech ?? (result.ok ? "Stock verified." : "Stock unavailable."),
        currentSessionCart: session.currentSessionCart,
      },
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "initiate_checkout_batch" && session) {
    const { initiateCheckoutBatchWithLiveInventory } = await import(
      "../agents/paymentCheckoutFlow.js"
    );
    let itemSelectors = normalizeCheckoutItemArgs(args) ?? [];
    if (!itemSelectors.length) {
      const { getCartSummary } = await import("../agents/cartManager.js");
      const summary = getCartSummary(session);
      itemSelectors = summary.items.map((line) => ({
        variant_id: line.variantId,
        title: line.title,
        quantity: line.quantity,
      }));
    }
    const facilityType = String(args.facility_type ?? args.facilityType ?? "").trim();
    const startEmailRaw = String(
      args.start_email_capture ?? args.startEmailCapture ?? "true",
    )
      .trim()
      .toLowerCase();
    const startEmailCapture = !["false", "0", "no", "off"].includes(startEmailRaw);
    const result = await initiateCheckoutBatchWithLiveInventory(session, itemSelectors, {
      startEmailCapture,
      facilityType: facilityType || undefined,
    });
    return {
      tool,
      args,
      ok: result.ok,
      status: result.ok ? "ok" : "blocked",
      data: {
        status: result.ok ? "ok" : "blocked",
        message: result.ok ? result.speech : result.message,
        ...(result.ok
          ? {
              remainingUnits: result.remainingUnits,
              cartUpdated: result.cartUpdated,
              stockVerified: result.stockVerified,
              checkoutGroupId: result.checkoutGroupId,
              instructions:
                "CheckoutManager batch locked. Continue letter-by-letter email verification, then call send_checkout_email with confirmed_email_id and this checkout_group_id.",
            }
          : { cartUpdated: result.cartUpdated }),
      },
      errorMessage: result.ok ? undefined : result.message,
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "send_checkout_email" && session) {
    const customerName = (args.customerName ?? args.name ?? "").trim();
    const itemSelectors = normalizeCheckoutItemArgs(args);
    const confirmedEmailId = String(
      args.confirmed_email_id ?? args.confirmedEmailId ?? "",
    ).trim();
    let checkoutGroupId = String(
      args.checkout_group_id ?? args.checkoutGroupId ?? "",
    ).trim();

    const { hasUnacknowledgedFailure, buildFailureStateSpeech } = await import(
      "../agents/failureState.js"
    );
    if (hasUnacknowledgedFailure(session)) {
      const speech =
        buildFailureStateSpeech(session) ??
        "The previous checkout step failed. Please acknowledge that before we retry.";
      return {
        tool,
        args: { confirmedEmailId, checkoutGroupId, customerName },
        ok: false,
        status: "blocked",
        errorMessage: speech,
        data: {
          status: "blocked",
          message: speech,
          instructions:
            "FAILURE_STATE: Acknowledge the prior failure before retry. No dual/fallback payment path.",
        } satisfies CheckoutEmailToolResult,
        elapsedMs: Date.now() - started,
      };
    }

    const {
      getLatestConfirmedEmailId,
      getConfirmedEmailById,
      issueConfirmedEmail,
    } = await import("../agents/emailConfirmationManager.js");

    // Prefer opaque confirmed_email_id; migrate confirmed session email into an id once.
    let emailId = confirmedEmailId || getLatestConfirmedEmailId(session) || "";
    if (!emailId) {
      const conf = session.emailConfirmation;
      const addr = conf?.confirmedEmail ?? conf?.normalizedEmail;
      if (conf?.confirmationStatus === "confirmed" && addr) {
        emailId = issueConfirmedEmail(session, addr, "payment_link").confirmedEmailId;
      }
    }
    if (!emailId || !getConfirmedEmailById(session, emailId)) {
      return {
        tool,
        args: { confirmedEmailId: emailId, checkoutGroupId, customerName },
        ok: false,
        status: "blocked",
        errorMessage:
          "confirmed_email_id required — complete letter-by-letter email confirmation first.",
        data: {
          status: "blocked",
          message: "ActionGateway rejected send: missing confirmed_email_id.",
          instructions:
            "Do not pass raw customerEmail to send. Confirm email, then call execute with confirmed_email_id + checkout_group_id.",
        } satisfies CheckoutEmailToolResult,
        elapsedMs: Date.now() - started,
      };
    }

    const {
      planCheckoutGroup,
      cartLinesToGroupLines,
      getCheckoutGroup,
    } = await import("../domain/checkoutModels.js");
    const { resolveCheckoutLineItems, getCartSummary } = await import("../agents/cartManager.js");

    if (!checkoutGroupId) {
      const resolved = resolveCheckoutLineItems(session, itemSelectors);
      if (!resolved.ok || !resolved.items.length) {
        const summary = getCartSummary(session);
        if (summary.isEmpty) {
          return {
            tool,
            args: { confirmedEmailId: emailId, customerName },
            ok: false,
            status: "empty",
            errorMessage: "Cart is empty — add books before checkout.",
            elapsedMs: Date.now() - started,
          };
        }
      }
      const lines = resolved.ok
        ? cartLinesToGroupLines(resolved.items)
        : cartLinesToGroupLines(
            getCartSummary(session).items.map((l) => ({
              variantId: l.variantId,
              productId: l.productId ?? "",
              title: l.title,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              price: l.price,
              isbn: l.isbn,
            })),
          );
      const planned = planCheckoutGroup(session, lines);
      if (!planned.ok) {
        return {
          tool,
          args: { confirmedEmailId: emailId, customerName },
          ok: false,
          status: "blocked",
          errorMessage: planned.message,
          data: { status: "blocked", message: planned.message },
          elapsedMs: Date.now() - started,
        };
      }
      checkoutGroupId = planned.group.checkoutGroupId;
    } else if (!getCheckoutGroup(session, checkoutGroupId)) {
      return {
        tool,
        args: { confirmedEmailId: emailId, checkoutGroupId, customerName },
        ok: false,
        status: "blocked",
        errorMessage: "Unknown checkout_group_id.",
        elapsedMs: Date.now() - started,
      };
    }

    const { ActionGateway } = await import("../runtime/actionGateway.js");
    const result = await ActionGateway.executeCheckoutGroup(
      {
        session,
        checkoutGroupId,
        confirmedEmailId: emailId,
        customerName,
      },
      {
        callId: session.callSid,
        actionId: `act_${Date.now().toString(36)}`,
        idempotencyKey: getCheckoutGroup(session, checkoutGroupId)?.idempotencyKey,
        workflowId: "checkout",
      },
    );

    let status: "sent" | "blocked" | "empty" | "error" | "failed" = result.ok ? "sent" : "failed";
    if (!result.ok) {
      if (/email|confirm/i.test(result.message)) status = "blocked";
      else if (/empty/i.test(result.message)) status = "empty";
    }

    return {
      tool,
      args: { confirmedEmailId: emailId, checkoutGroupId, customerName },
      ok: result.ok,
      status,
      data: {
        status: result.ok ? "sent" : "blocked",
        message: result.message,
        invoiceUrl: result.invoiceUrl,
        checkoutGroupId: result.checkoutGroupId,
        remainingCartUnits: result.remainingUnits,
        instructions: result.ok
          ? result.remainingUnits && result.remainingUnits > 0
            ? "MULTI-BATCH: Link sent. Call initiate_checkout_batch for the next partition, confirm email, then send_checkout_email with confirmed_email_id + checkout_group_id."
            : "Checkout complete. Ask if they need anything else."
          : "FAILURE_STATE recorded. Acknowledge to the caller before retrying this checkout_group_id.",
      } satisfies CheckoutEmailToolResult,
      errorMessage: result.ok ? undefined : result.message,
      elapsedMs: Date.now() - started,
    };
  }

  if (tool === "create_support_case" && session) {
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

    try {
      const { ActionGateway } = await import("../runtime/actionGateway.js");
      const created = await ActionGateway.createSupportCase(
        { session, reason: "Voice agent escalation", issueSummary, customerName, callbackEmail: customerEmail },
        { callId: session.callSid, actionId: `esc_${Date.now().toString(36)}`, workflowId: "support_escalation" },
      );
      const data: SupportEscalationToolResult = {
        status: created.ok ? "sent" : "error",
        message: created.ok
          ? `Support case ${created.caseId} created.`
          : created.error || "I'm sorry, I couldn't escalate right now, please try again",
      };
      return {
        tool,
        args: { customerName, customerEmail, issueSummary },
        ok: created.ok,
        status: created.ok ? "sent" : "error",
        data,
        errorMessage: created.ok
          ? undefined
          : created.error || "I'm sorry, I couldn't escalate right now, please try again",
        elapsedMs: Date.now() - started,
      };
    } catch {
      return {
        tool,
        args,
        ok: false,
        status: "api_error",
        errorMessage: "I'm sorry, I couldn't escalate right now, please try again",
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

    if (session && shouldBlockOrderLookupReinvoke(session, orderNumber || rawInput)) {
      const cached = getActiveOrderContext(session);
      if (cached) {
        return {
          tool,
          args: { orderNumber: orderNumber || rawInput },
          ok: true,
          status: "found",
          data: {
            status: "found",
            orderView: {
              verificationLevel: session.isVerifiedCaller ? "verified" : "unverified",
              order_number: String(cached.order_number ?? ""),
            },
            is_verified_caller: session.isVerifiedCaller === true,
          },
          elapsedMs: Date.now() - started,
        };
      }
      return {
        tool,
        args: { orderNumber: orderNumber || rawInput },
        ok: true,
        status: "ok",
        data: {
          status: "found",
          orderView: {
            verificationLevel: session.isVerifiedCaller ? "verified" : "unverified",
            order_number: String(getActiveOrderContext(session)?.order_number ?? session.currentOrder?.orderNumber ?? ""),
          },
          is_verified_caller: session.isVerifiedCaller === true,
          message: "order_lookup_complete: reuse ACTIVE ORDER CONTEXT — do not re-query Shopify for this order.",
        },
        elapsedMs: Date.now() - started,
      };
    }

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
      const lookupSession = session ?? ({
        callSid,
        from: "",
        to: "",
        phase: "active",
        isVerifiedCaller: false,
      } as unknown as CallSession);
      const data = await lookupOrderForCaller(lookupSession, orderNumber);

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
        errorMessage:
          "UNAUTHORIZED: is_verified is false — cannot access order_history. Redirect the caller to support for personal order history queries.",
        data: {
          status: "api_error",
          message:
            "UNAUTHORIZED: Verification required. Offer to escalate to support so they can verify identity and follow up on past orders.",
          error: "UNAUTHORIZED: You cannot fetch history details for unverified callers.",
          failureState: "VERIFICATION_REQUIRED",
          redirect_to_support: true,
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
      const productView =
        data.status === "found" && data.variantId && data.bookName
          ? {
              title: data.bookName,
              price: data.price ?? "",
              isbn: data.isbn,
              variantId: data.variantId,
              available: data.inStock,
            }
          : null;
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
        data: (productView ? { ...data, productView } : data) as BookAvailabilityResult,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : CATALOG_TOOL_ERROR_LLM_PAYLOAD.reason;
      return catalogErrorRecord(tool, { isbn }, started, reason);
    }
  }

  if (tool === "search_shopify_book_by_title") {
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
    const productView =
      data.status === "found" && data.variantId && data.bookName
        ? {
            title: data.bookName,
            price: data.price ?? "",
            isbn: data.isbn,
            variantId: data.variantId,
            available: data.inStock,
          }
        : null;
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
      data: (productView ? { ...data, productView } : data) as BookAvailabilityResult,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : CATALOG_TOOL_ERROR_LLM_PAYLOAD.reason;
    return catalogErrorRecord(tool, { title }, started, reason);
  }
  }

  return {
    tool,
    args,
    ok: false,
    status: "blocked",
    errorMessage: `Unsupported tool: ${tool}`,
    elapsedMs: Date.now() - started,
  };
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

  if (
    record.data &&
    "status" in record.data &&
    record.data.status != null &&
    isMaintenanceToolStatus(record.data.status)
  ) {
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
        : "DICTATION PROTOCOL: Speak tracking_number_for_tts with COMMA PACING for sequences longer than 5 digits (e.g. '9, 4, 4, 9, 0, 1'). ZERO PUNCTUATION — never hyphens, dashes, or points. Append 'Did you get all that, or should I repeat any part of it?' Never mention items, fees, payment, or other order fields. On 'repeat that' / 'say it slower', re-speak ONLY tracking_number_for_tts even slower — never the full order. If the caller asks What comes after [Number]?, string-slice the cached ID and speak ONLY the remainder. If the caller confirms they wrote it down, stop dictating and ask if they need anything else.",
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
    if (record.tool === "update_cart_item_quantity" && record.ok && options?.session) {
      const memory = getSessionMemory(options.session);
      memory.awaitingQuantityReply = false;
      memory.quantityAskCount = 0;
    }
    return JSON.stringify({
      status: record.status,
      ok: record.ok,
      cart: record.data,
      instructions:
        record.tool === "get_cart_summary"
          ? "Summarize the cart naturally for the caller."
          : "Confirm the cart change warmly. Offer: adjust quantity, search for another book, or prepare the payment link. Do NOT re-ask how many copies.",
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
          "Do NOT say the system is undergoing updates. Apologize to the customer, state exactly which book caused the problem using the reason field, and immediately call create_support_case with a concise issueSummary.",
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

  if (record.tool === "create_support_case") {
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
      : "Follow OMNI-CHANNEL ESCALATION S.O.P.: ask for email, verify letter-by-letter, call create_support_case, then say a support case was created.";
    if (data.status === "not_found") {
      return JSON.stringify({
        status: "NOT_FOUND",
        queriedTitle: data.queriedTitle,
        instructions: notFoundInstruction,
      });
    }
    const similar = data.similarMatches ?? [];
    const volumeHint =
      data.needsDisambiguation ||
      (typeof data.matchConfidence === "number" &&
        data.matchConfidence < 90 &&
        similar.length > 1)
        ? "LOW CONFIDENCE MATCH (<90%): Ask 'I found [X] and [Y], which one were you looking for?' using the top similarMatches. Do NOT add to cart until they choose."
        : data.exactMatch === true
          ? "EXACT MATCH: Say confidently: 'I found exactly what you are looking for: [bookName] for [price].' Follow ZERO ASSUMPTION QUANTITY — ask ONCE how many copies before update_cart_item_quantity unless the caller already stated a quantity. When they answer 'one'/'1'/'just one', treat it as quantity=1 immediately — never re-ask."
          : data.exactMatch === false && similar.length > 1
            ? "No exact match. Say: 'I don't have that exact book, but I found these similar options...' Read the top 2 or 3 entries from similarMatches (bookName, inStock, price) and ask if they want one. Follow ZERO ASSUMPTION QUANTITY before update_cart_item_quantity. Bare answers like 'one' map to quantity=1 — do not loop."
            : suppressEscalation
              ? "If in stock, offer to add to cart using update_cart_item_quantity with action_type=add and variant_id/unit_price from this response — follow ZERO ASSUMPTION QUANTITY (ask once). If out of stock, apologize and offer similar titles — do NOT escalate unless they ask for support."
              : "If in stock, offer to add to cart using update_cart_item_quantity with action_type=add and variant_id/unit_price from this response — follow ZERO ASSUMPTION QUANTITY and ask how many copies once unless quantity was already stated. If out of stock, follow OMNI-CHANNEL ESCALATION S.O.P.";
    if (options?.session && data.status === "found") {
      const memory = getSessionMemory(options.session);
      memory.awaitingQuantityReply = true;
      memory.quantityAskCount = Math.max(1, memory.quantityAskCount ?? 0);
    }
    return JSON.stringify({
      status: data.status,
      found: data.status === "found",
      data,
      variant_id: data.variantId,
      matchConfidence: data.matchConfidence,
      needsDisambiguation: data.needsDisambiguation,
      tags: data.tags ?? [],
      metafields: data.metafields ?? [],
      similarMatches: similar,
      instructions:
        `${volumeHint} FACILITY COMPLIANCE: Before update_cart_item_quantity, ask for facility type/state if unknown and pass facility_type. Inspect tags/metafields for restricted_state_* / restricted_facility_type_* — never add a restricted title.`,
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

  if (record.tool === "get_shopify_order_status" && "orderView" in record.data) {
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
      orderView: record.data.orderView,
      instructions:
        "SECURITY CLEARANCE (UNBREAKABLE RULE): If isVerifiedCaller is FALSE, you are ONLY forbidden from sharing two things: (1) the exact Shipping Address, and (2) Past Order History / previous months' orders. You MUST share EVERYTHING ELSE — Item Names, Item Prices, Quantities, Subtotal, Taxes, Shipping Fees, Total Amount, Payment Method, Notification Emails, and Timeline Events. Do not apologize; simply provide the info. ABSOLUTE BLACKLIST: shipping_address and past_order_history only. Prefer orderView DTO fields — never invent vault fields. CONVERSATION LOCK / order_lookup_complete: Once an order is FOUND, you are LOCKED to this order — NEVER re-invoke get_shopify_order_status for follow-ups. If the user provides digits (e.g. What comes after 47 / 80111 / 48011), assume they are clarifying Tracking ID or the order already in memory — NOT a new search. Locate digits in tracking_number_for_tts/spatialIndex and read only the remainder. STRICT CONVERSATIONAL ECONOMY: On FOUND the spoken gateway is already handled (order number + customer name + status + follow-up only) — answer only what they ask next; never volunteer tracking, address, or items. EXPLAINING PAYMENTS & NOTIFICATIONS: Act like a human concierge when asked. If financial_status is PAID and card last4 is null, explain via sourceName / Litextension when present. For notification routing say notifications were routed to the contact on file when asked. If tracking is in orderNote, say you found tracking securely noted, then dictate. Never invent vague lockdowns from privacy_tier wording. Translate events via THE SHOPIFY BRAIN — never read events verbatim and never speak staff names. physical_items and item_count are BOOKS ONLY. Keys always present: customer_name, customer_email, payment_method, payment_method_last4, card_brand, cancel_reason, refund_reason, refund_notification_email, order_confirmation_email (null when absent — never invent). LEGACY DATA: If tracking_number is null, scan orderNote/note for Tracking Number. For tracking dictation use comma pacing (9, 4, 4, 9, 0, 1) with zero hyphens/dashes/points. Never end_call for missing fields.",
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
  const orderNumber = String(getActiveOrderContext(session)?.order_number ?? "").trim();
  const verified = session.isVerifiedCaller === true ? "verified" : "unverified";
  const parts = [issue, `Caller ${session.from}`, `${verified} line`];
  if (orderNumber) parts.push(`Order ${orderNumber}`);
  return parts.join(" | ");
}

/** Keys that must always exist on active order context / LLM payloads (null allowed). */
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
  data: Record<string, any>,
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
  data: Record<string, any>,
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
