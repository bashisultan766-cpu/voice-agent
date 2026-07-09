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

export interface CartItemInput {
  variant_id?: string;
  product_id?: string;
  title?: string;
  isbn?: string;
  unit_price?: string;
  price?: string;
  quantity?: number;
}

function resolveUnitPrice(raw: CartItemInput): string | undefined {
  const candidate = (raw.unit_price ?? raw.price ?? "").trim();
  if (!candidate) return undefined;
  return normalizeShopifyUnitPrice(candidate);
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
    const variantGid = parseVariantGid(raw.variant_id ?? "");
    const title = (raw.title ?? "").trim();
    const quantity = Math.max(1, Number(raw.quantity ?? 1) || 1);
    const unitPrice = resolveUnitPrice(raw);

    if (!variantGid && !title) continue;

    const lineKey = variantGid ?? `custom:${title.toLowerCase()}`;
    const existing = cart.find(
      (line) =>
        (variantGid && line.variantId === variantGid) ||
        (!variantGid && title && line.title.toLowerCase() === title.toLowerCase()),
    );

    if (existing) {
      existing.quantity += quantity;
      if (raw.isbn) existing.isbn = raw.isbn;
      if (raw.product_id) existing.productId = raw.product_id;
      if (unitPrice) {
        existing.unitPrice = unitPrice;
        existing.price = unitPrice;
      }
      continue;
    }

    cart.push({
      variantId: variantGid ?? lineKey,
      productId: (raw.product_id ?? "").trim(),
      title: title || "Book",
      quantity,
      unitPrice,
      price: unitPrice,
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
    const variantGid = parseVariantGid(raw.variant_id ?? "");
    const title = (raw.title ?? "").trim().toLowerCase();
    const removeQty = Math.max(1, Number(raw.quantity ?? 1) || 1);

    const index = cart.findIndex(
      (line) =>
        (variantGid && line.variantId === variantGid) ||
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

/** Set an absolute line quantity (e.g. "change to 5 copies") — removes the line when target is 0. */
export function setCartLineQuantity(
  session: CallSession,
  item: CartItemInput,
  targetQuantity: number,
): ShoppingCartLineItem[] {
  const cart = ensureShoppingCart(session);
  const variantGid = parseVariantGid(item.variant_id ?? "");
  const title = (item.title ?? "").trim().toLowerCase();
  const qty = Math.max(0, Math.floor(Number(targetQuantity) || 0));

  const index = cart.findIndex(
    (line) =>
      (variantGid && line.variantId === variantGid) ||
      (title && line.title.toLowerCase() === title),
  );

  if (qty <= 0) {
    if (index >= 0) cart.splice(index, 1);
    return cart;
  }

  if (index >= 0) {
    cart[index].quantity = qty;
    const unitPrice = resolveUnitPrice(item);
    if (unitPrice) {
      cart[index].unitPrice = unitPrice;
      cart[index].price = unitPrice;
    }
    return cart;
  }

  return addToCart(session, [{ ...item, quantity: qty }]);
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
    return "ACTIVE SHOPPING CART: Empty. Help the caller find books and use add_to_cart when they want items.";
  }

  return (
    "ACTIVE SHOPPING CART: The caller's current cart is persisted for this call. " +
    "Use add_to_cart with variant_id and unit_price from search results (full gid://shopify/ProductVariant/...), " +
    "or remove_from_cart / get_cart_summary to manage it. " +
    `JSON: ${JSON.stringify(summary.items)}`
  );
}
