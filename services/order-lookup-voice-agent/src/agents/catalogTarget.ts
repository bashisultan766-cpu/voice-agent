/**
 * Binds update_cart_item_quantity to the caller's most recent catalog search result.
 */
import type { BookAvailabilityResult } from "../adapters/shopifyStorefrontAdapter.js";
import type { CallSession } from "../types/order.js";

export interface LastCatalogSearch {
  title: string;
  variantId?: string;
  unitPrice?: string;
  isbn?: string;
  recordedAt: number;
  tags?: string[];
  metafields?: Array<{ namespace: string; key: string; value: string }>;
}

import { getSessionMemory } from "./sessionMemory.js";

export function recordLastCatalogSearch(
  session: CallSession,
  data: BookAvailabilityResult,
): void {
  if (data.status !== "found") return;
  const title = (data.bookName ?? data.queriedTitle ?? "").trim();
  if (!title && !data.variantId) return;
  session.lastCatalogSearch = {
    title,
    variantId: data.variantId,
    unitPrice: data.price,
    isbn: data.isbn,
    recordedAt: Date.now(),
    tags: data.tags ?? [],
    metafields: data.metafields ?? [],
  };
  const memory = getSessionMemory(session);
  memory.lastProductTitle = title;
  memory.lastProductId = data.variantId;
  memory.lastProductPrice = data.price;
  memory.lastProductIsbn = data.isbn;
  memory.unresolvedUserGoal = null;
}

export function buildCatalogTargetSystemMessage(session: CallSession): string | null {
  const target = session.lastCatalogSearch;
  if (!target?.variantId) return null;
  return [
    "CURRENT CATALOG TARGET (MANDATORY):",
    `Most recent book search: "${target.title}".`,
    `variant_id=${target.variantId}`,
    target.unitPrice ? `unit_price=${target.unitPrice}` : "",
    "When the caller says add it, add to cart, or gives a quantity for the book you just found, update_cart_item_quantity MUST use this variant_id and unit_price — NEVER a prior search or an item already in the cart unless they explicitly name a different book. Use action_type=set_exact for 'make it X / I want X total / don't add, make it Y', action_type=add only for 'add X more', and action_type=remove for 'minus/remove X'.",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface CartLineInput {
  title?: string;
  variant_id?: string;
  unit_price?: string;
  price?: string;
  quantity?: number;
}

/** Correct stale LLM variant picks by binding to the latest catalog search. */
export function reconcileAddToCartItems(
  session: CallSession,
  items: CartLineInput[],
): CartLineInput[] {
  const target = session.lastCatalogSearch;
  if (!target?.variantId || items.length !== 1) return items;

  const item = items[0];
  const requested = (item.variant_id ?? "").trim();
  if (requested === target.variantId) return items;

  return [
    {
      ...item,
      variant_id: target.variantId,
      title: target.title,
      unit_price: item.unit_price ?? item.price ?? target.unitPrice,
    },
  ];
}
