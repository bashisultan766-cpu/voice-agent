import type { ToolResult } from './tool-orchestrator.service';
import {
  canAdvanceCheckoutStage,
  isLlmProductInStock,
  sanitizeCheckoutStageForStock,
  stockFieldsFromVariants,
} from './voice-stock-sales-policy.util';

export type LlmCheckoutStage =
  | 'idle'
  | 'product_discovery'
  | 'product_selected'
  | 'quantity'
  | 'email'
  | 'payment'
  | 'payment_sent'
  | 'done';

export type LlmSelectedProduct = {
  productId?: string;
  variantId?: string;
  handle?: string;
  title: string;
  price?: string | null;
  stock?: number | null;
  inventoryQuantity?: number | null;
  availableForSale?: boolean;
  inStock?: boolean;
  outOfStock?: boolean;
  /** ISO timestamp when catalog row was last synced locally. */
  catalogSyncedAt?: string | null;
  /** ISO timestamp when live inventory was last checked for this selection. */
  inventoryCheckedAt?: string | null;
};

export type LlmAgentConversationState = {
  customerIntent?: string;
  selectedProducts: LlmSelectedProduct[];
  quantities: Record<string, number>;
  customerEmail?: string | null;
  lastSearchedProducts: LlmSelectedProduct[];
  checkoutStage: LlmCheckoutStage;
  lastToolCalls: string[];
  paymentLinkCreated?: boolean;
  paymentLinkSent?: boolean;
  checkoutLinkId?: string | null;
  checkoutUrl?: string | null;
};

export const LLM_AGENT_STATE_KEY = 'llmAgentState';

export function emptyLlmAgentState(): LlmAgentConversationState {
  return {
    selectedProducts: [],
    quantities: {},
    customerEmail: null,
    lastSearchedProducts: [],
    checkoutStage: 'idle',
    lastToolCalls: [],
  };
}

export function parseLlmAgentState(raw: unknown): LlmAgentConversationState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyLlmAgentState();
  }
  const o = raw as Record<string, unknown>;
  const selected = Array.isArray(o.selectedProducts)
    ? (o.selectedProducts as LlmSelectedProduct[])
    : [];
  const searched = Array.isArray(o.lastSearchedProducts)
    ? (o.lastSearchedProducts as LlmSelectedProduct[])
    : [];
  const quantities =
    o.quantities && typeof o.quantities === 'object' && !Array.isArray(o.quantities)
      ? (o.quantities as Record<string, number>)
      : {};
  const stage = o.checkoutStage;
  const checkoutStage: LlmCheckoutStage =
    stage === 'product_discovery' ||
    stage === 'product_selected' ||
    stage === 'quantity' ||
    stage === 'email' ||
    stage === 'payment' ||
    stage === 'done'
      ? stage
      : 'idle';
  return {
    customerIntent: typeof o.customerIntent === 'string' ? o.customerIntent : undefined,
    selectedProducts: selected,
    quantities,
    customerEmail: typeof o.customerEmail === 'string' ? o.customerEmail : null,
    lastSearchedProducts: searched,
    checkoutStage,
    lastToolCalls: Array.isArray(o.lastToolCalls)
      ? o.lastToolCalls.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

export function formatStateForPrompt(state: LlmAgentConversationState): string {
  const lines: string[] = [];
  if (state.customerIntent) lines.push(`Customer intent: ${state.customerIntent}.`);
  lines.push(`Checkout stage: ${state.checkoutStage}.`);
  if (state.lastSearchedProducts.length) {
    const list = state.lastSearchedProducts
      .slice(0, 5)
      .map((p, i) => {
        const price = p.price ? `, price ${p.price}` : '';
        const stock =
          p.stock != null ? `, stock ${p.stock}` : '';
        const avail = p.inStock === false ? ', OUT OF STOCK' : p.inStock ? ', in stock' : '';
        const vid = p.variantId ? `, variantId ${p.variantId}` : '';
        return `${i + 1}) ${p.title}${price}${stock}${avail}${vid}`;
      })
      .join('; ');
    lines.push(`Last search results (use for "first one" / "that book"): ${list}.`);
  }
  if (state.selectedProducts.length) {
    const sel = state.selectedProducts
      .map((p) => {
        const q = p.variantId && state.quantities[p.variantId] ? ` x${state.quantities[p.variantId]}` : '';
        return `${p.title}${q}`;
      })
      .join('; ');
    lines.push(`Selected for order: ${sel}.`);
  }
  if (state.customerEmail) lines.push(`Customer email: ${state.customerEmail}.`);
  if (state.paymentLinkSent) lines.push('Payment link email: already sent for this order.');
  else if (state.paymentLinkCreated) lines.push('Payment link: created; email not confirmed sent yet.');
  if (state.lastToolCalls.length) {
    lines.push(`Recent tools: ${state.lastToolCalls.slice(-5).join(', ')}.`);
  }
  return lines.join('\n');
}

function pickStock(variants: Record<string, unknown>[]): number | null {
  let sum = 0;
  let any = false;
  for (const v of variants) {
    const n = v.inventoryQuantity ?? v.inventory_quantity;
    if (typeof n === 'number') {
      sum += Math.max(0, n);
      any = true;
    }
  }
  return any ? sum : null;
}

function mapSearchResult(row: Record<string, unknown>): LlmSelectedProduct | null {
  const title = typeof row.title === 'string' ? row.title : '';
  if (!title) return null;
  const variants = Array.isArray(row.variants) ? (row.variants as Record<string, unknown>[]) : [];
  const v0 = variants[0];
  const price = typeof v0?.price === 'string' ? v0.price : null;
  const variantId =
    typeof v0?.id === 'string'
      ? v0.id
      : typeof row.primaryVariantId === 'string'
        ? row.primaryVariantId
        : undefined;
  const productId = typeof row.id === 'string' ? row.id : undefined;
  const handle = typeof row.handle === 'string' ? row.handle : undefined;
  const catalogSyncedAt =
    typeof row.syncedAt === 'string'
      ? row.syncedAt
      : row.syncedAt instanceof Date
        ? row.syncedAt.toISOString()
        : null;
  const inventoryCheckedAt = new Date().toISOString();
  const stockSnap = stockFieldsFromVariants(
    variants.map((v) => ({
      inventory_quantity:
        typeof v.inventory_quantity === 'number'
          ? v.inventory_quantity
          : typeof v.inventoryQuantity === 'number'
            ? v.inventoryQuantity
            : 0,
      availableForSale: v.availableForSale === true,
    })),
  );
  return {
    productId,
    variantId,
    handle,
    title,
    price,
    stock: pickStock(variants),
    inventoryQuantity: stockSnap.inventoryQuantity,
    availableForSale: stockSnap.availableForSale,
    inStock: stockSnap.inStock,
    outOfStock: !stockSnap.inStock,
    catalogSyncedAt,
    inventoryCheckedAt,
  };
}

/** Update conversation state from a tool execution result. */
export function applyToolResultToState(
  state: LlmAgentConversationState,
  llmToolName: string,
  result: ToolResult,
): LlmAgentConversationState {
  const next: LlmAgentConversationState = {
    ...state,
    lastToolCalls: [...state.lastToolCalls, llmToolName].slice(-12),
  };
  if (!result.ok || !result.data || typeof result.data !== 'object') {
    return next;
  }
  const data = result.data as Record<string, unknown>;

  if (llmToolName === 'ShopifyProductSearch') {
    const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
    const mapped = results.map(mapSearchResult).filter((p): p is LlmSelectedProduct => p != null);
    next.lastSearchedProducts = mapped;
    next.checkoutStage = mapped.length ? 'product_discovery' : next.checkoutStage;
    next.customerIntent = 'product_search';
    if (mapped.length === 1 && isLlmProductInStock(mapped[0])) {
      next.selectedProducts = [mapped[0]!];
      next.checkoutStage = 'product_selected';
    } else {
      next.selectedProducts = [];
    }
    return sanitizeCheckoutStageForStock(next);
  }

  if (llmToolName === 'ShopifyProductDetails') {
    const product = data.product as Record<string, unknown> | undefined;
    if (product && typeof product.title === 'string') {
      const variants = Array.isArray(product.variants) ? (product.variants as Record<string, unknown>[]) : [];
      const v0 = variants[0];
      const entry: LlmSelectedProduct = {
        productId: typeof product.productId === 'string' ? product.productId : undefined,
        variantId:
          typeof product.selectedVariantId === 'string'
            ? product.selectedVariantId
            : typeof v0?.variantId === 'string'
              ? v0.variantId
              : undefined,
        handle: typeof product.handle === 'string' ? product.handle : undefined,
        title: product.title,
        price: typeof v0?.price === 'string' ? v0.price : null,
        stock: pickStock(variants),
        catalogSyncedAt:
          typeof product.syncedAt === 'string'
            ? product.syncedAt
            : product.syncedAt instanceof Date
              ? product.syncedAt.toISOString()
              : null,
        inventoryCheckedAt: new Date().toISOString(),
      };
      const stockSnap = stockFieldsFromVariants(
        variants.map((v) => ({
          inventory_quantity:
            typeof v.inventory_quantity === 'number'
              ? v.inventory_quantity
              : typeof v.inventoryQuantity === 'number'
                ? v.inventoryQuantity
                : 0,
          availableForSale: v.availableForSale === true,
        })),
      );
      entry.inventoryQuantity = stockSnap.inventoryQuantity;
      entry.availableForSale = stockSnap.availableForSale;
      entry.inStock = stockSnap.inStock;
      entry.outOfStock = !stockSnap.inStock;
      entry.stock = stockSnap.inventoryQuantity;
      if (stockSnap.inStock) {
        next.selectedProducts = [entry];
        next.checkoutStage = 'product_selected';
        next.customerIntent = 'product_selected';
      } else {
        next.selectedProducts = [];
        next.checkoutStage = 'product_discovery';
        next.customerIntent = 'product_search';
      }
    }
    return sanitizeCheckoutStageForStock(next);
  }

  if (llmToolName === 'CreatePaymentLink') {
    if (!canAdvanceCheckoutStage(next, 'payment')) {
      return sanitizeCheckoutStageForStock(next);
    }
    next.checkoutStage = 'payment';
    next.customerIntent = 'payment_link';
    return next;
  }

  if (llmToolName === 'GetOrderStatus') {
    next.customerIntent = 'order_status';
    return next;
  }

  if (llmToolName === 'HumanHandoff') {
    next.customerIntent = 'human_handoff';
    return next;
  }

  return next;
}

/** Merge explicit caller signals (quantity, email) into state before the LLM turn. */
export function mergeCallerSignalsIntoState(
  state: LlmAgentConversationState,
  signals: { quantity?: number; email?: string; intentHint?: string },
): LlmAgentConversationState {
  const next = { ...state };
  if (signals.intentHint) next.customerIntent = signals.intentHint;
  if (signals.email?.trim() && canAdvanceCheckoutStage(next, 'email')) {
    next.customerEmail = signals.email.trim();
    next.checkoutStage = 'email';
  }
  if (signals.quantity != null && signals.quantity > 0 && canAdvanceCheckoutStage(next, 'quantity')) {
    const sel =
      next.selectedProducts[0] ??
      next.lastSearchedProducts.find((p) => isLlmProductInStock(p));
    if (sel && !isLlmProductInStock(sel)) {
      return sanitizeCheckoutStageForStock(next);
    }
    const vid = sel?.variantId;
    if (vid) {
      next.quantities = { ...next.quantities, [vid]: signals.quantity };
      next.checkoutStage = 'quantity';
    }
  }
  return sanitizeCheckoutStageForStock(next);
}

export function inferIntentHintFromText(text: string): string | undefined {
  const t = text.toLowerCase().trim();
  if (!t) return undefined;
  if (/^(hi|hello|hey|good morning|good afternoon)\b/.test(t)) return 'greeting';
  if (/\b(how are you|what'?s up|nice to meet)\b/.test(t)) return 'small_talk';
  if (/\b(order status|where is my order|track)\b/.test(t)) return 'order_status';
  if (/\b(refund|return policy)\b/.test(t)) return 'refund_policy';
  if (/\b(shipping|delivery)\b/.test(t)) return 'shipping_policy';
  if (/\b(speak to|human|representative|manager)\b/.test(t)) return 'human_handoff';
  if (/\b(history|romance|fiction|book|title|author|isbn)\b/.test(t)) return 'product_search';
  if (/\b(yes|first one|that one|order this|add this|i want)\b/.test(t)) return 'product_selected';
  if (/\b\d+\s*(copies|books|quantity)\b/.test(t) || /^\d{1,3}$/.test(t)) return 'quantity_selection';
  if (/@/.test(t) || /\b(at|dot)\s+\w+/.test(t)) return 'email_collection';
  return undefined;
}
