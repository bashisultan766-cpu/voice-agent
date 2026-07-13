/**
 * Single order-lookup + transactional cart workflow — shared speech, retry signals,
 * status classification, and currentSessionCart projection.
 * Found orders use Concierge Gateway speech only (status + follow-up; no automatic dump).
 * Cart mutations go through applySessionCartQuantity so order + cart sticky state stay reconciled
 * (avoids a double workflow where LLM tools and deterministic cart turns diverge).
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import {
  ORDER_LOOKUP_MAINTENANCE_SPOKEN,
  ORDER_LOOKUP_RETRY_SPOKEN,
  ORDER_NOT_FOUND_STRICT_SPOKEN,
  SHOPIFY_TIMEOUT_SPOKEN,
} from "../constants/systemMessages.js";
import type { CallSession, ShoppingCartLineItem } from "../types/order.js";
import { orderNumbersMatch } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import {
  type CartActionType,
  type CartItemInput,
  ensureShoppingCart,
  updateCartItemQuantity,
} from "./cartManager.js";
import { groundedOrderSpeech } from "./fulfillmentHandlers.js";
import {
  ORDER_FOUND_PASSIVE_SPEECH,
  buildOrderFoundGatewaySpeech,
  buildStickyOrderStillOpenSpeech,
} from "./orderLookupProtocol.js";
import { hasConfirmedOrderContext } from "./orderContextPolicy.js";

export {
  ORDER_FOUND_PASSIVE_SPEECH,
  buildOrderFoundGatewaySpeech,
  buildStickyOrderStillOpenSpeech,
};

/** Sticky session memory — order already loaded for this call. */
export type CurrentSessionOrder = {
  orderNumber: string;
  customerName?: string;
  fulfillmentStatus?: string;
  financialStatus?: string;
};

/** Transactional cart engine — sku/variant key → quantity. */
export type CurrentSessionCart = Record<string, number>;

/** Verbal intent → engine action (aliases: set→set_exact, minus→remove). */
export type SessionCartActionType = "add" | "set" | "minus" | CartActionType;

export interface SessionCartUpdateResult {
  cart: ShoppingCartLineItem[];
  currentSessionCart: CurrentSessionCart;
  actionType: CartActionType;
  needsRemovalConfirmation?: boolean;
  confirmationSpeech?: string;
  message: string;
}

function cartLineKey(line: ShoppingCartLineItem): string {
  return (line.isbn ?? line.variantId ?? line.title).trim() || line.title;
}

/** Rebuild currentSessionCart from shoppingCart lines (single projection). */
export function syncCurrentSessionCart(session: CallSession): CurrentSessionCart {
  const cart = ensureShoppingCart(session);
  const map: CurrentSessionCart = {};
  for (const line of cart) {
    map[cartLineKey(line)] = line.quantity;
  }
  session.currentSessionCart = map;
  return map;
}

export function getCurrentSessionCart(session?: CallSession): CurrentSessionCart {
  if (!session) return {};
  if (session.currentSessionCart) return { ...session.currentSessionCart };
  return syncCurrentSessionCart(session);
}

/** Normalize LLM / speech action_type into cartManager enums. */
export function normalizeSessionCartAction(
  actionRaw: string | undefined,
): CartActionType {
  const raw = String(actionRaw ?? "add").trim().toLowerCase();
  if (raw === "set" || raw === "set_exact" || raw === "exact") return "set_exact";
  if (raw === "minus" || raw === "remove" || raw === "subtract") return "remove";
  return "add";
}

/**
 * Stateful cart engine: add = current+incoming, set = incoming, minus = current-incoming.
 * If minus/set would drop below 1 without confirmRemoval, ask before clearing the line.
 */
export function applySessionCartQuantity(
  session: CallSession,
  item: CartItemInput,
  quantity: number,
  actionTypeRaw: SessionCartActionType | string,
  options?: { confirmRemoval?: boolean },
): SessionCartUpdateResult {
  const actionType = normalizeSessionCartAction(String(actionTypeRaw));
  const cart = ensureShoppingCart(session);
  const variantHint = (item.variant_id ?? item.item_id ?? item.sku ?? "").trim();
  const title = (item.title ?? "").trim().toLowerCase();
  const index = cart.findIndex(
    (line) =>
      (variantHint &&
        (line.variantId === variantHint ||
          line.isbn === variantHint ||
          line.variantId.endsWith(`/${variantHint}`))) ||
      (title && line.title.toLowerCase() === title),
  );
  const currentQty = index >= 0 ? cart[index]!.quantity : 0;
  const incoming = Math.max(0, Math.floor(Number(quantity) || 0));

  let newTotal: number;
  if (actionType === "add") {
    newTotal = currentQty + Math.max(1, incoming || 1);
  } else if (actionType === "remove") {
    newTotal = currentQty - Math.max(1, incoming || 1);
  } else {
    newTotal = incoming;
  }

  if (newTotal < 1 && currentQty >= 1 && !options?.confirmRemoval) {
    const line = index >= 0 ? cart[index]! : undefined;
    const titleLabel = line?.title || item.title || "that book";
    const variantId = line?.variantId || variantHint;
    if (variantId) {
      session.pendingCartRemoval = {
        variantId,
        title: titleLabel,
        currentQuantity: currentQty,
      };
    }
    const confirmationSpeech =
      `You have ${currentQty} ${currentQty === 1 ? "copy" : "copies"} of ${titleLabel} in your cart. ` +
      `Do you want to remove the item entirely?`;
    return {
      cart: [...cart],
      currentSessionCart: syncCurrentSessionCart(session),
      actionType,
      needsRemovalConfirmation: true,
      confirmationSpeech,
      message: confirmationSpeech,
    };
  }

  session.pendingCartRemoval = undefined;
  const updated =
    newTotal < 1
      ? updateCartItemQuantity(session, item, 0, "set_exact")
      : actionType === "set_exact"
        ? updateCartItemQuantity(session, item, newTotal, "set_exact")
        : updateCartItemQuantity(
            session,
            item,
            Math.max(1, incoming || 1),
            actionType,
          );

  const currentSessionCart = syncCurrentSessionCart(session);
  return {
    cart: updated,
    currentSessionCart,
    actionType,
    message: `Cart updated with action_type=${actionType}.`,
  };
}

/** Confirm a pending full-line removal after the agent asked. */
export function confirmPendingCartRemoval(
  session: CallSession,
  confirm: boolean,
): SessionCartUpdateResult | null {
  const pending = session.pendingCartRemoval;
  if (!pending) return null;
  if (!confirm) {
    session.pendingCartRemoval = undefined;
    return {
      cart: [...ensureShoppingCart(session)],
      currentSessionCart: syncCurrentSessionCart(session),
      actionType: "remove",
      message: `Okay — keeping ${pending.currentQuantity} ${pending.currentQuantity === 1 ? "copy" : "copies"} of ${pending.title} in your cart.`,
    };
  }
  return applySessionCartQuantity(
    session,
    { variant_id: pending.variantId, title: pending.title },
    pending.currentQuantity,
    "minus",
    { confirmRemoval: true },
  );
}

/** True when this call session already completed a successful order lookup. */
export function isOrderLookupComplete(session?: CallSession): boolean {
  return (
    Boolean(session?.orderLookupComplete) ||
    Boolean(session?.currentSessionOrder?.orderNumber) ||
    hasConfirmedOrderContext(session)
  );
}

export function getCurrentSessionOrderNumber(session?: CallSession): string {
  return String(
    session?.currentSessionOrder?.orderNumber ??
      session?.currentOrderData?.order_number ??
      session?.currentOrder?.orderNumber ??
      session?.lastOrderStatusResult?.orderNumber ??
      "",
  );
}

/**
 * Context lock: after order_lookup_complete, forbid re-calling get_shopify_order_status
 * for the same order — rely on cached JSON. Allow only when the caller names a different order.
 */
export function shouldBlockOrderLookupReinvoke(
  session: CallSession | undefined,
  requestedOrderNumber?: string,
): boolean {
  if (!isOrderLookupComplete(session)) return false;

  const cached = getCurrentSessionOrderNumber(session);
  if (!cached) return true;

  const requested = normalizeOrderNumber(requestedOrderNumber ?? "");
  if (!requested) return true;

  return orderNumbersMatch(cached, requested);
}

/** Persist sticky CurrentSessionOrder from a found Shopify result. */
export function syncCurrentSessionOrder(
  session: CallSession,
  data: {
    orderNumber?: string;
    customerName?: string;
    fulfillmentStatus?: string;
    financialStatus?: string;
  },
): void {
  const orderNumber = String(data.orderNumber ?? "")
    .replace(/^#/, "")
    .trim();
  if (!orderNumber) return;
  session.currentSessionOrder = {
    orderNumber,
    customerName: data.customerName,
    fulfillmentStatus: data.fulfillmentStatus,
    financialStatus: data.financialStatus,
  };
  session.orderLookupComplete = true;
}

export function clearCurrentSessionOrder(session: CallSession): void {
  session.currentSessionOrder = undefined;
  session.orderLookupComplete = false;
}

export function markOrderLookupComplete(session: CallSession): void {
  session.orderLookupComplete = true;
}

export function clearOrderLookupComplete(session: CallSession): void {
  session.orderLookupComplete = false;
  session.currentSessionOrder = undefined;
}

export function isOrderLookupInsistenceUtterance(text: string): boolean {
  return /\b((?:this\s+is\s+the\s+)?correct|right)\s+order|please\s+(?:find|look\s*(?:it\s+)?up|try\s+again|provide)\b/i.test(
    text.trim(),
  );
}

export function isTransientOrderLookupStatus(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "api_error" || status === "system_maintenance" || status === "throttled";
}

/**
 * Only cache durable positive / format failures.
 * Never cache `not_found` — a first Shopify miss must not block the next live retry
 * when the caller insists with the same digits (common after STT noise or a brief miss).
 */
export function isStableOrderLookupStatus(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "found" || status === "invalid_format";
}

/** Deterministic spoken response for any order lookup tool result — one workflow, no LLM paraphrase. */
export function speechForOrderLookupResult(
  result: OrderStatusResult,
  options?: { insistence?: boolean; session?: CallSession },
): string {
  if (
    result.status === "api_error" &&
    /timeout/i.test(String(result.message ?? ""))
  ) {
    return SHOPIFY_TIMEOUT_SPOKEN;
  }
  if (options?.insistence && isTransientOrderLookupStatus(result.status)) {
    return ORDER_LOOKUP_RETRY_SPOKEN;
  }
  if (isTransientOrderLookupStatus(result.status)) {
    return ORDER_LOOKUP_MAINTENANCE_SPOKEN;
  }
  if (result.status === "found") {
    return groundedOrderSpeech(result, options?.session);
  }
  if (result.status === "not_found") {
    return ORDER_NOT_FOUND_STRICT_SPOKEN;
  }
  return groundedOrderSpeech(result, options?.session);
}

export function isRetriableOrderLookupMiss(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "not_found";
}

export function shouldBypassOrderLookupCache(
  userMessage: string,
  phase?: string,
): boolean {
  if (isOrderLookupInsistenceUtterance(userMessage)) return true;
  if (phase === "awaiting_order_number") return true;
  return /\b(try\s+again|one\s+more\s+time|digit\s+by\s+digit|check\s+(?:the\s+)?system|search\s+again)\b/i.test(
    userMessage.trim(),
  );
}
