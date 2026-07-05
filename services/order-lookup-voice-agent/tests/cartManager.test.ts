import { describe, expect, it } from "vitest";
import {
  addToCart,
  getCartSummary,
  removeFromCart,
} from "../src/agents/cartManager.js";
import type { CallSession } from "../src/types/order.js";

function makeSession(): CallSession {
  return {
    callSid: "CA_CART_TEST",
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
  };
}

describe("cartManager", () => {
  it("adds items and increments quantity for duplicates", () => {
    const session = makeSession();
    addToCart(session, [
      { title: "The Great Gatsby", variant_id: "gid://shopify/ProductVariant/111", quantity: 1 },
    ]);
    addToCart(session, [
      { title: "The Great Gatsby", variant_id: "gid://shopify/ProductVariant/111", quantity: 2 },
    ]);

    const summary = getCartSummary(session);
    expect(summary.lineCount).toBe(1);
    expect(summary.totalUnits).toBe(3);
  });

  it("removes items and reduces quantity partially", () => {
    const session = makeSession();
    addToCart(session, [
      { title: "1984", variant_id: "gid://shopify/ProductVariant/222", quantity: 3 },
      { title: "Dune", variant_id: "gid://shopify/ProductVariant/333", quantity: 1 },
    ]);

    removeFromCart(session, [{ title: "1984", quantity: 1 }]);
    expect(getCartSummary(session).totalUnits).toBe(3);

    removeFromCart(session, [{ title: "Dune" }]);
    expect(getCartSummary(session).lineCount).toBe(1);
    expect(getCartSummary(session).items[0].title).toBe("1984");
  });

  it("reports empty cart", () => {
    const session = makeSession();
    expect(getCartSummary(session).isEmpty).toBe(true);
  });

  it("does not treat ISBN as a Shopify variant GID", () => {
    const session = makeSession();
    addToCart(session, [
      {
        title: "The Great Gatsby",
        variant_id: "9780692089705",
        isbn: "9780692089705",
        unit_price: "12.99",
        quantity: 1,
      },
    ]);

    const summary = getCartSummary(session);
    expect(summary.items[0].variantId).toBe("custom:the great gatsby");
    expect(summary.items[0].unitPrice).toBe("12.99");
    expect(summary.items[0].price).toBe("12.99");
  });

  it("calculates merchandise total from unit prices and quantities", () => {
    const session = makeSession();
    addToCart(session, [
      { title: "Bulk Title", unit_price: "10.00", quantity: 50 },
      { title: "Single Copy", unit_price: "9.99", quantity: 1 },
    ]);

    const summary = getCartSummary(session);
    expect(summary.merchandiseTotal).toBe("509.99");
    expect(summary.totalUnits).toBe(51);
  });
});
