import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyToolResultToState,
  emptyLlmAgentState,
  mergeCallerSignalsIntoState,
  type LlmAgentConversationState,
} from './llm-agent-conversation-state.util';
import type { ToolResult } from './tool-orchestrator.service';
import {
  buildProductSearchVoiceSummary,
  formatOutOfStockWithAlternative,
  isProductOfferInStock,
  pickInStockSearchPresentation,
  shouldBlockCheckoutForOutOfStock,
} from './voice-stock-sales-policy.util';

describe('isProductOfferInStock', () => {
  it('returns false when inventory is zero', () => {
    assert.equal(
      isProductOfferInStock({
        title: 'Sold Out Book',
        variants: [{ price: '10.00', inventory_quantity: 0, availableForSale: true }],
      }),
      false,
    );
  });

  it('returns true when inventory is positive', () => {
    assert.equal(
      isProductOfferInStock({
        title: 'In Stock Book',
        variants: [{ price: '10.00', inventory_quantity: 5, availableForSale: true }],
      }),
      true,
    );
  });
});

describe('buildProductSearchVoiceSummary', () => {
  it('does not ask to order when inventory is zero', () => {
    const line = buildProductSearchVoiceSummary({
      primary: {
        title: 'Ghost Title',
        variants: [{ price: '12.00', inventory_quantity: 0 }],
      },
      topWasOutOfStock: true,
      requiresClarification: false,
    });
    assert.match(line, /out of stock/i);
    assert.doesNotMatch(line, /order it/i);
  });

  it('asks to order when inventory is positive', () => {
    const line = buildProductSearchVoiceSummary({
      primary: {
        title: 'Atomic Habits',
        variants: [{ price: '18.99', inventory_quantity: 12 }],
      },
      topWasOutOfStock: false,
      requiresClarification: false,
    });
    assert.match(line, /order it/i);
    assert.match(line, /12 copies in stock/i);
  });

  it('auto-pivots to in-stock alternative', () => {
    const line = formatOutOfStockWithAlternative('A Feast for Crows', {
      title: "A Thug's Heartbeat: Rocko's Street Justice",
      variants: [{ price: '15.95', inventory_quantity: 133 }],
    });
    assert.match(line, /out of stock/i);
    assert.match(line, /Thug's Heartbeat/i);
    assert.match(line, /\$15\.95/);
    assert.match(line, /133 copies/i);
    assert.match(line, /instead/i);
  });
});

describe('pickInStockSearchPresentation', () => {
  it('selects next in-stock product when top match is unavailable', () => {
    const items = [
      { title: 'Out of Stock Top' },
      { title: 'Available Alternative' },
    ];
    const pick = pickInStockSearchPresentation(items, (item) => ({
      title: item.title,
      variants:
        item.title === 'Out of Stock Top'
          ? [{ price: '10.00', inventory_quantity: 0 }]
          : [{ price: '15.95', inventory_quantity: 133 }],
    }));
    assert.equal(pick.primary.title, 'Available Alternative');
    assert.equal(pick.topWasOutOfStock, true);
    assert.equal(pick.unavailableTitle, 'Out of Stock Top');
  });
});

describe('checkout state machine', () => {
  it('blocks checkout when selected product is out of stock', () => {
    const state = {
      ...emptyLlmAgentState(),
      selectedProducts: [
        {
          title: 'Sold Out',
          inStock: false,
          outOfStock: true,
          stock: 0,
          inventoryQuantity: 0,
        },
      ],
      checkoutStage: 'product_selected' as const,
    };
    const block = shouldBlockCheckoutForOutOfStock(state);
    assert.equal(block.blocked, true);

    const merged = mergeCallerSignalsIntoState(state, { quantity: 2, email: 'a@b.com' });
    assert.notEqual(merged.checkoutStage, 'payment');
    assert.notEqual(merged.checkoutStage, 'email');
    assert.equal(merged.quantities && Object.keys(merged.quantities).length, 0);
  });

  it('allows quantity and email when in stock', () => {
    let state: LlmAgentConversationState = {
      ...emptyLlmAgentState(),
      selectedProducts: [
        {
          title: 'In Stock',
          variantId: 'var_1',
          inStock: true,
          stock: 8,
          inventoryQuantity: 8,
        },
      ],
      checkoutStage: 'product_selected' as const,
    };
    state = mergeCallerSignalsIntoState(state, { quantity: 2 });
    assert.equal(state.checkoutStage, 'quantity');
    state = mergeCallerSignalsIntoState(state, { email: 'buyer@example.com' });
    assert.equal(state.checkoutStage, 'email');
  });

  it('does not select out-of-stock single search result for checkout', () => {
    const searchResult: ToolResult = {
      ok: true,
      toolName: 'searchProducts',
      storeId: 'store_1',
      data: {
        results: [
          {
            id: 'gid://shopify/Product/1',
            title: 'Zero Stock Book',
            variants: [{ id: 'var_1', price: '9.99', inventoryQuantity: 0, availableForSale: false }],
          },
        ],
      },
    };
    const next = applyToolResultToState(emptyLlmAgentState(), 'ShopifyProductSearch', searchResult);
    assert.equal(next.selectedProducts.length, 0);
    assert.equal(next.checkoutStage, 'product_discovery');
  });
});
