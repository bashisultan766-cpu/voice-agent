/**
 * In-call shopping cart — persistent across the full voice session.
 */
import type { CallSession, ShoppingCartLineItem } from "../types/order.js";
import { logger } from "../utils/logger.js";
import { parseVariantGid } from "../utils/shopifyGid.js";
import {
  formatLineTotal,
  normalizeShopifyUnitPrice,
  sumCartMerchandiseTotal,
} from "../utils/shopifyMoney.js";

export type CartActionType = "add" | "remove" | "set_exact";

export interface CartItemInput {
  variant_id?: string;
  product_id?: string;
  title?: string;
  isbn?: string;
  sku?: string;
  item_id?: string;
  unit_price?: string;
  price?: string;
  quantity?: number;
}

function resolveUnitPrice(raw: CartItemInput): string | undefined {
  const candidate = (raw.unit_price ?? raw.price ?? "").trim();
  if (!candidate) return undefined;
  return normalizeShopifyUnitPrice(candidate);
}

function resolveVariantHint(raw: CartItemInput): string {
  return (raw.variant_id ?? raw.item_id ?? raw.sku ?? "").trim();
}

function findCartLineIndex(cart: ShoppingCartLineItem[], raw: CartItemInput): number {
  const variantGid = parseVariantGid(resolveVariantHint(raw));
  const title = (raw.title ?? "").trim().toLowerCase();
  return cart.findIndex(
    (line) =>
      (variantGid && line.variantId === variantGid) ||
      (title && line.title.toLowerCase() === title),
  );
}

export function ensureShoppingCart(session: CallSession): ShoppingCartLineItem[] {
  if (!session.shoppingCart) {
    session.shoppingCart = [];
  }
  return session.shoppingCart;
}

function logCartUpdate(session: CallSession, cart: ShoppingCartLineItem[]): void {
  logger.info("cart_updated", {
    callSid: session.callSid.slice(0, 8),
    itemCount: cart.length,
    totalUnits: cart.reduce((sum, line) => sum + line.quantity, 0),
  });
}

/**
 * Unified cart quantity updater — single source of truth for add / remove / set_exact.
 */
export function updateCartItemQuantity(
  session: CallSession,
  item: CartItemInput,
  quantity: number,
  actionType: CartActionType,
): ShoppingCartLineItem[] {
  const cart = ensureShoppingCart(session);
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const index = findCartLineIndex(cart, item);
  const currentQty = index >= 0 ? cart[index]!.quantity : 0;

  let targetQty: number;
  if (actionType === "add") {
    const delta = Math.max(1, qty || 1);
    targetQty = currentQty + delta;
  } else if (actionType === "remove") {
    const delta = Math.max(1, qty || 1);
    targetQty = Math.max(0, currentQty - delta);
  } else {
    targetQty = qty;
  }

  return setCartLineQuantity(session, item, targetQty);
}

export function addToCart(session: CallSession, items: CartItemInput[]): ShoppingCartLineItem[] {
  let cart = ensureShoppingCart(session);
  for (const raw of items) {
    const quantity = Math.max(1, Number(raw.quantity ?? 1) || 1);
    cart = updateCartItemQuantity(session, raw, quantity, "add");
  }
  return cart;
}

export function removeFromCart(session: CallSession, items: CartItemInput[]): ShoppingCartLineItem[] {
  let cart = ensureShoppingCart(session);
  for (const raw of items) {
    const removeQty = Math.max(1, Number(raw.quantity ?? 1) || 1);
    cart = updateCartItemQuantity(session, raw, removeQty, "remove");
  }
  return cart;
}

/** Set an absolute line quantity (e.g. "change to 5 copies") — removes the line when target is 0. */
export function setCartLineQuantity(
  session: CallSession,
  item: CartItemInput,
  targetQuantity: number,
): ShoppingCartLineItem[] {
  const cart = ensureShoppingCart(session);
  const variantHint = resolveVariantHint(item);
  const variantGid = parseVariantGid(variantHint);
  const title = (item.title ?? "").trim();
  const qty = Math.max(0, Math.floor(Number(targetQuantity) || 0));
  const index = findCartLineIndex(cart, item);

  if (qty <= 0) {
    if (index >= 0) cart.splice(index, 1);
    logCartUpdate(session, cart);
    return cart;
  }

  const unitPrice = resolveUnitPrice(item);
  if (index >= 0) {
    const line = cart[index]!;
    line.quantity = qty;
    if (item.isbn) line.isbn = item.isbn;
    if (item.product_id) line.productId = item.product_id;
    if (unitPrice) {
      line.unitPrice = unitPrice;
      line.price = unitPrice;
    }
    logCartUpdate(session, cart);
    return cart;
  }

  if (!variantGid && !title) {
    return cart;
  }

  const lineKey = variantGid ?? `custom:${title.toLowerCase()}`;
  cart.push({
    variantId: variantGid ?? lineKey,
    productId: (item.product_id ?? "").trim(),
    title: title || "Book",
    quantity: qty,
    unitPrice,
    price: unitPrice,
    isbn: item.isbn?.trim(),
  });
  logCartUpdate(session, cart);
  return cart;
}

export function getCartSummary(session: CallSession): {
  items: ShoppingCartLineItem[];
  totalUnits: number;
  lineCount: number;
  merchandiseTotal: string;
  isEmpty: boolean;
} {
  const items = [...ensureShoppingCart(session)];
  const totalUnits = items.reduce((sum, line) => sum + line.quantity, 0);
  return {
    items,
    totalUnits,
    lineCount: items.length,
    merchandiseTotal: sumCartMerchandiseTotal(items),
    isEmpty: items.length === 0,
  };
}

export function getLineMerchandiseTotal(line: ShoppingCartLineItem): string {
  return formatLineTotal(line.unitPrice ?? line.price, line.quantity);
}

export function clearShoppingCart(session: CallSession): void {
  session.shoppingCart = [];
  session.pendingInvoiceUrl = undefined;
  session.pendingDraftOrderName = undefined;
}

export function validateCartForCheckout(
  items: Array<{ title: string; variantId: string; unitPrice?: string; price?: string }>,
): string | null {
  for (const line of items) {
    if (line.variantId.startsWith("custom:") && !(line.unitPrice ?? line.price)) {
      return `Missing unit_price for custom cart line "${line.title}".`;
    }
    if (
      !line.variantId.startsWith("custom:") &&
      !line.variantId.startsWith("gid://shopify/ProductVariant/")
    ) {
      return `Invalid Shopify variant on "${line.title}" — checkout blocked until variant is corrected.`;
    }
  }
  return null;
}

export function buildCartContextSystemMessage(session: CallSession): string {
  const summary = getCartSummary(session);
  if (summary.isEmpty) {
    return "ACTIVE SHOPPING CART: Empty. Help the caller find books and use update_cart_item_quantity when they want items.";
  }

  return (
    "ACTIVE SHOPPING CART: The caller's current cart is persisted for this call. " +
    "Use update_cart_item_quantity with action_type add | remove | set_exact, and variant_id / unit_price from search results " +
    "(full gid://shopify/ProductVariant/...). Use get_cart_summary to read the cart. " +
    `JSON: ${JSON.stringify(summary.items)}`
  );
}
