/**
 * Logistics Intelligence — inventory urgency, shipability gating, and pre-checkout stock double-check.
 * Prevents over-selling and failed-delivery against facility packaging constraints.
 */
import type { CallSession, ShoppingCartLineItem } from "../types/order.js";
import {
  ensureShoppingCart,
  updateCartItemQuantity,
  type CheckoutItemSelector,
  type CartItemInput,
} from "./cartManager.js";
import { resolveCheckoutLineItems } from "./cartManager.js";
import { logger } from "../utils/logger.js";

export const LOW_STOCK_THRESHOLD = 3;

export interface InventoryUrgencyResult {
  status: "ok" | "low_stock" | "out_of_stock";
  inventoryQuantity: number;
  temporaryReservation: boolean;
  speech?: string;
  suggestAlternatives: boolean;
}

export interface LogisticsFeasibilityResult {
  ok: boolean;
  shipable: boolean;
  title: string;
  reason?: string;
  speech?: string;
}

export interface StockVerificationLine {
  variantId: string;
  title: string;
  requestedQty: number;
  availableQty: number;
  status: "ok" | "reduced" | "removed" | "unavailable";
}

export interface VerifyStockAvailabilityResult {
  ok: boolean;
  /** True when CartState was mutated due to stock volatility. */
  cartUpdated: boolean;
  lines: StockVerificationLine[];
  removedTitles: string[];
  speech?: string;
  viableSelectors: CheckoutItemSelector[];
}

export type LiveInventoryMap = Record<string, number>;

function metafieldValue(
  metafields: Array<{ namespace: string; key: string; value: string }> | undefined,
  key: string,
): string | undefined {
  const hit = (metafields ?? []).find(
    (m) => m.key.toLowerCase() === key.toLowerCase() || m.key.toLowerCase().endsWith(`.${key.toLowerCase()}`),
  );
  return hit?.value?.trim();
}

function hasPackageRestriction(
  metafields: Array<{ namespace: string; key: string; value: string }> | undefined,
  tags: string[] | undefined,
  facilityType: string,
): boolean {
  const facility = facilityType.trim().toLowerCase();
  const restriction = metafieldValue(metafields, "package_restriction")?.toLowerCase() ?? "";
  const maxWeight = metafieldValue(metafields, "max_weight")?.toLowerCase() ?? "";

  if (!restriction && !maxWeight) {
    // Tag-based packaging blocks
    for (const tag of tags ?? []) {
      const t = tag.toLowerCase();
      if (
        t.includes("package_restriction") ||
        t.includes("non_shipable") ||
        t.includes("non-shipable") ||
        t.includes("no_ship") ||
        t === "unshipable"
      ) {
        return true;
      }
    }
    return false;
  }

  if (
    /\b(non[_-]?shipable|no[_-]?ship|blocked|forbidden|reject)\b/i.test(restriction) ||
    restriction === "true" ||
    restriction === "1"
  ) {
    return true;
  }

  // Facility-specific restriction list in metafield value (comma/semicolon separated).
  if (facility && restriction) {
    const tokens = restriction.split(/[,;|/]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.some((t) => facility.includes(t) || t.includes(facility.replace(/\s+/g, "_")))) {
      return true;
    }
  }

  // max_weight: "restricted" / "0" / facility-coded blocks
  if (
    maxWeight === "restricted" ||
    maxWeight === "0" ||
    maxWeight === "blocked" ||
    (facility && maxWeight.includes(facility.replace(/\s+/g, "_")))
  ) {
    return true;
  }

  return false;
}

/**
 * Urgency Guardrail — evaluate inventory before / while adding to cart.
 * inventoryQuantity < 3 → temporary reservation warning
 * inventoryQuantity == 0 → out of stock / suggest alternatives
 */
export function evaluateInventoryUrgency(
  inventoryQuantity: number | undefined,
  bookTitle: string,
  requestedQty: number,
): InventoryUrgencyResult {
  const qty =
    inventoryQuantity == null || !Number.isFinite(inventoryQuantity)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(inventoryQuantity));

  if (qty === 0) {
    return {
      status: "out_of_stock",
      inventoryQuantity: 0,
      temporaryReservation: false,
      suggestAlternatives: true,
      speech:
        `I'm sorry — ${bookTitle} is currently out of stock. ` +
        `I can check if a pre-order is available, or suggest similar titles that ship today.`,
    };
  }

  if (qty < LOW_STOCK_THRESHOLD) {
    const capped = Math.min(requestedQty, qty);
    return {
      status: "low_stock",
      inventoryQuantity: qty,
      temporaryReservation: true,
      suggestAlternatives: false,
      speech:
        `Just a heads-up: we only have ${qty} ${qty === 1 ? "copy" : "copies"} of ${bookTitle} left. ` +
        `I'll place a temporary reservation for ${capped} ${capped === 1 ? "copy" : "copies"} while we finish checkout.`,
    };
  }

  if (Number.isFinite(qty) && requestedQty > qty) {
    return {
      status: "low_stock",
      inventoryQuantity: qty,
      temporaryReservation: true,
      suggestAlternatives: false,
      speech:
        `We only have ${qty} ${qty === 1 ? "copy" : "copies"} of ${bookTitle} available right now. ` +
        `I'll reserve ${qty} for you with a temporary reservation.`,
    };
  }

  return {
    status: "ok",
    inventoryQuantity: Number.isFinite(qty) ? qty : -1,
    temporaryReservation: false,
    suggestAlternatives: false,
  };
}

/**
 * Shipability tool — gate checkout using metafields (max_weight, package_restriction) + tags.
 */
export function checkLogisticsFeasibility(
  skuOrLine: {
    title?: string;
    variantId?: string;
    sku?: string;
    tags?: string[];
    metafields?: Array<{ namespace: string; key: string; value: string }>;
  },
  facilityType: string,
): LogisticsFeasibilityResult {
  const title = (skuOrLine.title ?? "that book").trim() || "that book";
  const facility = (facilityType ?? "").trim();

  if (hasPackageRestriction(skuOrLine.metafields, skuOrLine.tags, facility)) {
    const speech =
      `I'm afraid I cannot process the payment for ${title} as it does not meet the facility's packaging requirements. ` +
      `I have removed it from your payment batch to keep the rest of your order safe.`;
    return {
      ok: false,
      shipable: false,
      title,
      reason: "package_restriction",
      speech,
    };
  }

  return { ok: true, shipable: true, title };
}

function resolveLiveQty(
  variantId: string,
  line: ShoppingCartLineItem | undefined,
  liveInventory?: LiveInventoryMap,
  inventoryUnavailable?: boolean,
): number {
  if (liveInventory && variantId in liveInventory) {
    return Math.max(0, Math.floor(Number(liveInventory[variantId]) || 0));
  }
  // Fail-closed: API refresh failed, or live map present but variant missing.
  if (inventoryUnavailable || liveInventory) {
    return 0;
  }
  if (line?.inventoryQuantity != null && Number.isFinite(line.inventoryQuantity)) {
    return Math.max(0, Math.floor(line.inventoryQuantity));
  }
  // No live refresh attempted — do not invent a stock-out in unit tests / early cart.
  return Number.POSITIVE_INFINITY;
}

/**
 * Atomic Finality Gate — double-check stock for a sku_list before payment-link generation.
 * Mutates CartState when availability dropped (reduce qty or remove line).
 * Fail-closed: when liveInventory is omitted after a refresh attempt, or inventoryUnavailable,
 * missing variants are treated as qty 0.
 */
export function verifyStockAvailability(
  session: CallSession,
  skuList: CheckoutItemSelector[] | null | undefined,
  options?: {
    liveInventory?: LiveInventoryMap;
    /** When true, stamped line qty is ignored — missing live keys = 0. */
    inventoryUnavailable?: boolean;
  },
): VerifyStockAvailabilityResult {
  const resolved = resolveCheckoutLineItems(session, skuList);
  if (!resolved.ok) {
    return {
      ok: false,
      cartUpdated: false,
      lines: [],
      removedTitles: [],
      speech: resolved.message,
      viableSelectors: [],
    };
  }

  const cart = ensureShoppingCart(session);
  const lines: StockVerificationLine[] = [];
  const removedTitles: string[] = [];
  const viableSelectors: CheckoutItemSelector[] = [];
  let cartUpdated = false;

  for (const item of resolved.items) {
    const available = resolveLiveQty(
      item.variantId,
      item,
      options?.liveInventory,
      options?.inventoryUnavailable,
    );
    const requested = item.quantity;

    if (!Number.isFinite(available)) {
      lines.push({
        variantId: item.variantId,
        title: item.title,
        requestedQty: requested,
        availableQty: -1,
        status: "ok",
      });
      viableSelectors.push({
        variant_id: item.variantId,
        title: item.title,
        quantity: requested,
      });
      continue;
    }

    if (available <= 0) {
      updateCartItemQuantity(
        session,
        { variant_id: item.variantId, title: item.title, quantity: item.quantity },
        item.quantity,
        "remove",
      );
      cartUpdated = true;
      removedTitles.push(item.title);
      lines.push({
        variantId: item.variantId,
        title: item.title,
        requestedQty: requested,
        availableQty: 0,
        status: "removed",
      });
      logger.info("stock_double_check_removed", {
        callSid: session.callSid.slice(0, 8),
        title: item.title,
        variantId: item.variantId.slice(0, 24),
      });
      continue;
    }

    if (available < requested) {
      // Cap cart line to available stock.
      const cartLine = cart.find((l) => l.variantId === item.variantId);
      const currentInCart = cartLine?.quantity ?? requested;
      if (currentInCart > available) {
        updateCartItemQuantity(
          session,
          { variant_id: item.variantId, title: item.title },
          available,
          "set_exact",
        );
        cartUpdated = true;
      }
      lines.push({
        variantId: item.variantId,
        title: item.title,
        requestedQty: requested,
        availableQty: available,
        status: "reduced",
      });
      viableSelectors.push({
        variant_id: item.variantId,
        title: item.title,
        quantity: available,
      });
      continue;
    }

    lines.push({
      variantId: item.variantId,
      title: item.title,
      requestedQty: requested,
      availableQty: available,
      status: "ok",
    });
    viableSelectors.push({
      variant_id: item.variantId,
      title: item.title,
      quantity: requested,
    });
  }

  // Refresh stamped inventory on remaining cart lines from live map.
  if (options?.liveInventory) {
    for (const line of ensureShoppingCart(session)) {
      if (line.variantId in options.liveInventory) {
        line.inventoryQuantity = options.liveInventory[line.variantId];
      }
    }
  }

  const ok = viableSelectors.length > 0;
  let speech: string | undefined;
  if (removedTitles.length && !ok) {
    speech =
      `I just re-checked inventory and ${removedTitles.join(" and ")} ` +
      `${removedTitles.length === 1 ? "is" : "are"} no longer available. ` +
      `I've updated your cart. Would you like me to find a similar title?`;
  } else if (removedTitles.length || lines.some((l) => l.status === "reduced")) {
    const reduced = lines.filter((l) => l.status === "reduced");
    const parts: string[] = [];
    if (removedTitles.length) {
      parts.push(
        `${removedTitles.join(" and ")} ${removedTitles.length === 1 ? "is" : "are"} no longer available and ${removedTitles.length === 1 ? "was" : "were"} removed`,
      );
    }
    for (const r of reduced) {
      parts.push(`${r.title} is limited to ${r.availableQty} ${r.availableQty === 1 ? "copy" : "copies"}`);
    }
    speech =
      `I just re-checked inventory before your payment link: ${parts.join("; ")}. ` +
      `Your cart is updated so we don't over-sell.`;
  }

  return { ok, cartUpdated, lines, removedTitles, speech, viableSelectors };
}

/**
 * Filter a checkout batch for logistics — remove non-shipable lines from cart + selectors.
 */
export function gateBatchForLogistics(
  session: CallSession,
  selectors: CheckoutItemSelector[],
  facilityType?: string,
): {
  ok: boolean;
  selectors: CheckoutItemSelector[];
  removed: Array<{ title: string; speech: string }>;
  speech?: string;
} {
  const facility = (facilityType ?? session.facilityType ?? "").trim();
  const resolved = resolveCheckoutLineItems(session, selectors);
  if (!resolved.ok) {
    return { ok: false, selectors: [], removed: [], speech: resolved.message };
  }

  const kept: CheckoutItemSelector[] = [];
  const removed: Array<{ title: string; speech: string }> = [];

  for (const item of resolved.items) {
    const check = checkLogisticsFeasibility(
      {
        title: item.title,
        variantId: item.variantId,
        tags: item.tags,
        metafields: item.metafields,
      },
      facility,
    );
    if (!check.ok) {
      updateCartItemQuantity(
        session,
        { variant_id: item.variantId, title: item.title, quantity: item.quantity },
        item.quantity,
        "remove",
      );
      removed.push({
        title: item.title,
        speech: check.speech ?? `Removed ${item.title} due to packaging restrictions.`,
      });
      continue;
    }
    kept.push({
      variant_id: item.variantId,
      title: item.title,
      quantity: item.quantity,
    });
  }

  const speech = removed.length
    ? removed.map((r) => r.speech).join(" ")
    : undefined;

  return {
    ok: kept.length > 0,
    selectors: kept,
    removed,
    speech,
  };
}

/** Resolve inventory qty for a cart write from item / last catalog search. */
export function resolveInventoryQuantityForCartAdd(
  session: CallSession,
  item: CartItemInput,
): number | undefined {
  if (item.inventoryQuantity != null && Number.isFinite(Number(item.inventoryQuantity))) {
    return Math.max(0, Math.floor(Number(item.inventoryQuantity)));
  }
  const catalog = session.lastCatalogSearch;
  if (!catalog) return undefined;
  const variantHint = (item.variant_id ?? item.item_id ?? item.sku ?? "").trim();
  if (variantHint && catalog.variantId && catalog.variantId !== variantHint) {
    const similar = catalog.similarMatches?.find((m) => m.variantId === variantHint);
    // similarMatches may not carry quantity — fall through
    void similar;
  }
  return catalog.quantity;
}

export const LogisticsIntelligence = {
  evaluateInventoryUrgency,
  checkLogisticsFeasibility,
  verifyStockAvailability,
  gateBatchForLogistics,
  resolveInventoryQuantityForCartAdd,
  LOW_STOCK_THRESHOLD,
} as const;
