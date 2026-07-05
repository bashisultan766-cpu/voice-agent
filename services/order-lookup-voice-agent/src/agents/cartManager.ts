/**
 * In-call shopping cart — persistent across the full voice session.
 */
import type { CallSession, ShoppingCartLineItem } from "../types/order.js";
import { logger } from "../utils/logger.js";

export interface CartItemInput {
  variant_id?: string;
  product_id?: string;
  title?: string;
  isbn?: string;
  quantity?: number;
}

function normalizeVariantId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("gid://shopify/ProductVariant/")) return trimmed;
  return `gid://shopify/ProductVariant/${trimmed.replace(/\D/g, "") || trimmed}`;
}

function cartKey(item: Pick<ShoppingCartLineItem, "variantId" | "title">): string {
  return item.variantId || item.title.toLowerCase();
}

export function ensureShoppingCart(session: CallSession): ShoppingCartLineItem[] {
  if (!session.shoppingCart) {
    session.shoppingCart = [];
  }
  return session.shoppingCart;
}

export function addToCart(session: CallSession, items: CartItemInput[]): ShoppingCartLineItem[] {
  const cart = ensureShoppingCart(session);

  for (const raw of items) {
    const variantId = normalizeVariantId(raw.variant_id ?? "");
    const title = (raw.title ?? "").trim();
    const quantity = Math.max(1, Number(raw.quantity ?? 1) || 1);

    if (!variantId && !title) continue;

    const existing = cart.find(
      (line) =>
        (variantId && line.variantId === variantId) ||
        (title && line.title.toLowerCase() === title.toLowerCase()),
    );

    if (existing) {
      existing.quantity += quantity;
      if (raw.isbn) existing.isbn = raw.isbn;
      if (raw.product_id) existing.productId = raw.product_id;
      continue;
    }

    cart.push({
      variantId: variantId || `title:${title.toLowerCase()}`,
      productId: (raw.product_id ?? "").trim(),
      title: title || "Book",
      quantity,
      isbn: raw.isbn?.trim(),
    });
  }

  logger.info("cart_updated", {
    callSid: session.callSid.slice(0, 8),
    itemCount: cart.length,
    totalUnits: cart.reduce((sum, line) => sum + line.quantity, 0),
  });

  return cart;
}

export function removeFromCart(session: CallSession, items: CartItemInput[]): ShoppingCartLineItem[] {
  const cart = ensureShoppingCart(session);

  for (const raw of items) {
    const variantId = normalizeVariantId(raw.variant_id ?? "");
    const title = (raw.title ?? "").trim().toLowerCase();
    const removeQty = Math.max(1, Number(raw.quantity ?? 1) || 1);

    const index = cart.findIndex(
      (line) =>
        (variantId && line.variantId === variantId) ||
        (title && line.title.toLowerCase() === title),
    );
    if (index < 0) continue;

    const line = cart[index];
    if (line.quantity > removeQty) {
      line.quantity -= removeQty;
    } else {
      cart.splice(index, 1);
    }
  }

  logger.info("cart_updated", {
    callSid: session.callSid.slice(0, 8),
    itemCount: cart.length,
    totalUnits: cart.reduce((sum, line) => sum + line.quantity, 0),
  });

  return cart;
}

export function getCartSummary(session: CallSession): {
  items: ShoppingCartLineItem[];
  totalUnits: number;
  lineCount: number;
  isEmpty: boolean;
} {
  const items = [...ensureShoppingCart(session)];
  const totalUnits = items.reduce((sum, line) => sum + line.quantity, 0);
  return {
    items,
    totalUnits,
    lineCount: items.length,
    isEmpty: items.length === 0,
  };
}

export function clearShoppingCart(session: CallSession): void {
  session.shoppingCart = [];
  session.pendingInvoiceUrl = undefined;
  session.pendingDraftOrderName = undefined;
}

export function buildCartContextSystemMessage(session: CallSession): string {
  const summary = getCartSummary(session);
  if (summary.isEmpty) {
    return "ACTIVE SHOPPING CART: Empty. Help the caller find books and use add_to_cart when they want items.";
  }

  return (
    "ACTIVE SHOPPING CART: The caller's current cart is persisted for this call. " +
    "Use add_to_cart / remove_from_cart / get_cart_summary to manage it. " +
    `JSON: ${JSON.stringify(summary.items)}`
  );
}
