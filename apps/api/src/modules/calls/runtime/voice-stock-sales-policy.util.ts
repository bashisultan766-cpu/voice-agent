import type { VoiceProductOfferInput } from './book-sales-voice.util';
import { formatVoiceUsd, pickPrimaryVariant, totalInventory } from './book-sales-voice.util';
import type { LlmAgentConversationState, LlmSelectedProduct } from './llm-agent-conversation-state.util';

export type StockAwareVariant = {
  inventory_quantity?: number | null;
  inventoryQuantity?: number | null;
  availableForSale?: boolean;
};

export function variantInventoryQuantity(v: StockAwareVariant): number {
  const raw = v.inventoryQuantity ?? v.inventory_quantity;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

/** In stock when quantity > 0 and not explicitly unavailable for sale. */
export function isVariantInStock(v: StockAwareVariant): boolean {
  const qty = variantInventoryQuantity(v);
  if (qty <= 0) return false;
  if (v.availableForSale === false) return false;
  return true;
}

export function isProductOfferInStock(product: VoiceProductOfferInput): boolean {
  if (!product.variants.length) return false;
  return product.variants.some((v) =>
    isVariantInStock({
      inventory_quantity: v.inventory_quantity,
      availableForSale: v.availableForSale,
    }),
  );
}

export function isLlmProductInStock(product: LlmSelectedProduct | null | undefined): boolean {
  if (!product) return false;
  if (product.outOfStock === true) return false;
  if (product.inStock === true) return true;
  if (product.inStock === false) return false;
  if (product.stock != null) return product.stock > 0;
  return true;
}

export function stockFieldsFromVariants(
  variants: StockAwareVariant[],
): { inventoryQuantity: number; availableForSale: boolean; inStock: boolean } {
  const inventoryQuantity = variants.reduce((sum, v) => sum + variantInventoryQuantity(v), 0);
  const availableForSale = variants.some((v) => v.availableForSale !== false && variantInventoryQuantity(v) > 0);
  const inStock = inventoryQuantity > 0 && availableForSale;
  return { inventoryQuantity, availableForSale, inStock };
}

export function formatOutOfStockWithAlternative(
  unavailableTitle: string,
  alternative: VoiceProductOfferInput,
): string {
  const title = alternative.title.trim();
  const variant = pickPrimaryVariant(alternative.variants);
  const priceSpoken = formatVoiceUsd(variant?.price ?? null);
  const stock = totalInventory(alternative.variants);
  const copies =
    stock != null && stock > 0 ? (stock === 1 ? '1 copy' : `${stock} copies`) : 'copies';
  const pricePart = priceSpoken ? ` for ${priceSpoken}` : '';
  return `That title, ${unavailableTitle.trim()}, is currently out of stock, but I do have ${title} available${pricePart} with ${copies} in stock. Would you like that one instead?`;
}

export function formatOutOfStockOnly(unavailableTitle: string): string {
  return `I'm sorry, ${unavailableTitle.trim()} is currently out of stock. I can search for a similar title that's available—what genre or author should I try?`;
}

/** Prefer first in-stock item in ranked order; surface auto-alternative when top match is OOS. */
export function pickInStockSearchPresentation<T extends { title: string }>(
  orderedItems: T[],
  toOffer: (item: T) => VoiceProductOfferInput,
): {
  primary: T;
  recommendedAlternatives: T[];
  topWasOutOfStock: boolean;
  unavailableTitle?: string;
} {
  if (!orderedItems.length) {
    throw new Error('pickInStockSearchPresentation requires at least one item');
  }
  const top = orderedItems[0]!;
  const firstInStock = orderedItems.find((item) => isProductOfferInStock(toOffer(item)));
  if (firstInStock) {
    const alternatives = orderedItems
      .filter((item) => item !== firstInStock && isProductOfferInStock(toOffer(item)))
      .slice(0, 2);
    return {
      primary: firstInStock,
      recommendedAlternatives: alternatives,
      topWasOutOfStock: top !== firstInStock,
      unavailableTitle: top !== firstInStock ? top.title : undefined,
    };
  }
  return {
    primary: top,
    recommendedAlternatives: [],
    topWasOutOfStock: true,
    unavailableTitle: top.title,
  };
}

export function buildProductSearchVoiceSummary(args: {
  primary: VoiceProductOfferInput;
  topWasOutOfStock: boolean;
  unavailableTitle?: string;
  requiresClarification: boolean;
}): string {
  const inStock = isProductOfferInStock(args.primary);
  if (!inStock) {
    return formatOutOfStockOnly(args.primary.title);
  }
  if (args.topWasOutOfStock && args.unavailableTitle) {
    return formatOutOfStockWithAlternative(args.unavailableTitle, args.primary);
  }
  if (args.requiresClarification) {
    const variant = pickPrimaryVariant(args.primary.variants);
    const priceSpoken = formatVoiceUsd(variant?.price ?? null);
    const title = args.primary.title.trim();
    if (priceSpoken) {
      return `I found something close: ${title}, priced at ${priceSpoken}. Is that the book you meant?`;
    }
    return `I found something similar: ${title}. Is that the one you meant?`;
  }
  const variant = pickPrimaryVariant(args.primary.variants);
  const priceSpoken = formatVoiceUsd(variant?.price ?? null);
  const stock = totalInventory(args.primary.variants);
  const title = args.primary.title.trim();
  if (priceSpoken && stock != null && stock > 0) {
    const copies = stock === 1 ? '1 copy' : `${stock} copies`;
    return `Yes, we have ${title} available. It is priced at ${priceSpoken} per copy, and we currently have ${copies} in stock. Would you like to order it?`;
  }
  if (priceSpoken) {
    return `Yes, we have ${title} available. It is priced at ${priceSpoken} per copy. Would you like to order it?`;
  }
  return `Yes, we have ${title} available. Would you like to order it?`;
}

const CHECKOUT_BLOCKED_STAGES = new Set(['quantity', 'email', 'payment', 'done']);

export function shouldBlockCheckoutForOutOfStock(
  state: LlmAgentConversationState,
): { blocked: boolean; message?: string } {
  const selected = state.selectedProducts[0];
  if (!selected || isLlmProductInStock(selected)) {
    return { blocked: false };
  }
  return {
    blocked: true,
    message:
      'That item is out of stock. I cannot create checkout, collect quantity, or send a payment link for it. Recommend an in-stock alternative from search results instead.',
  };
}

export function sanitizeCheckoutStageForStock(
  state: LlmAgentConversationState,
): LlmAgentConversationState {
  const selected = state.selectedProducts[0];
  if (!selected || isLlmProductInStock(selected)) return state;
  return {
    ...state,
    selectedProducts: [],
    quantities: {},
    checkoutStage:
      state.lastSearchedProducts.length > 0 ? 'product_discovery' : 'idle',
    customerIntent: 'product_search',
  };
}

function activeCheckoutProduct(
  state: LlmAgentConversationState,
): LlmSelectedProduct | undefined {
  return (
    state.selectedProducts[0] ??
    state.lastSearchedProducts.find((p) => isLlmProductInStock(p)) ??
    state.lastSearchedProducts[0]
  );
}

export function canAdvanceCheckoutStage(
  state: LlmAgentConversationState,
  targetStage: LlmAgentConversationState['checkoutStage'],
): boolean {
  if (!CHECKOUT_BLOCKED_STAGES.has(targetStage)) return true;
  const active = activeCheckoutProduct(state);
  if (!active) return true;
  return isLlmProductInStock(active);
}
