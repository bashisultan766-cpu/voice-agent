import { describe, expect, it } from "vitest";
import {
  addToCart,
  getCartSummary,
  removeFromCart,
  updateCartItemQuantity,
} from "../src/agents/cartManager.js";
import {
  parseCartQuantityFromSpeech,
  resolveCartActionTypeFromSpeech,
} from "../src/agents/catalogShoppingIntent.js";
import { tryDeterministicCartTurn } from "../src/agents/agentBrain.js";
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

describe("updateCartItemQuantity action_type", () => {
  it("set_exact replaces quantity instead of adding", () => {
    const session = makeSession();
    addToCart(session, [
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999", quantity: 20 },
    ]);
    updateCartItemQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      5,
      "set_exact",
    );
    expect(getCartSummary(session).totalUnits).toBe(5);
  });

  it("add increases and remove decreases with floor zero", () => {
    const session = makeSession();
    updateCartItemQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      3,
      "add",
    );
    updateCartItemQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      2,
      "add",
    );
    expect(getCartSummary(session).totalUnits).toBe(5);
    updateCartItemQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      10,
      "remove",
    );
    expect(getCartSummary(session).isEmpty).toBe(true);
  });

  it("set/minus aliases via applySessionCartQuantity sync currentSessionCart", async () => {
    const { applySessionCartQuantity } = await import("../src/agents/orderLookupWorkflow.js");
    const session = makeSession();
    applySessionCartQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      5,
      "add",
      { facilityType: "TX" },
    );
    expect(session.currentSessionCart?.["gid://shopify/ProductVariant/999"]).toBe(5);
    applySessionCartQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      3,
      "set",
      { facilityType: "TX" },
    );
    expect(getCartSummary(session).totalUnits).toBe(3);
    applySessionCartQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      1,
      "minus",
    );
    expect(getCartSummary(session).totalUnits).toBe(2);
  });

  it("asks confirmation before removing last copies", async () => {
    const { applySessionCartQuantity, confirmPendingCartRemoval } = await import(
      "../src/agents/orderLookupWorkflow.js"
    );
    const session = makeSession();
    applySessionCartQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      2,
      "add",
      { facilityType: "TX" },
    );
    const blocked = applySessionCartQuantity(
      session,
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999" },
      5,
      "minus",
    );
    expect(blocked.needsRemovalConfirmation).toBe(true);
    expect(getCartSummary(session).totalUnits).toBe(2);
    const cleared = confirmPendingCartRemoval(session, true);
    expect(cleared?.cart.length).toBe(0);
  });
});

describe("cart intent speech parsing", () => {
  it("maps absolute and negation phrases to set_exact", () => {
    expect(resolveCartActionTypeFromSpeech("Make it 5")).toBe("set_exact");
    expect(resolveCartActionTypeFromSpeech("I want 5 copies")).toBe("set_exact");
    expect(
      resolveCartActionTypeFromSpeech("No, don't add more, I just want 5 total"),
    ).toBe("set_exact");
    expect(resolveCartActionTypeFromSpeech("No, not 20, I want 5")).toBe("set_exact");
    expect(parseCartQuantityFromSpeech("No, don't add more, I just want 5 total")).toBe(5);
  });

  it("maps relative phrases to add/remove", () => {
    expect(resolveCartActionTypeFromSpeech("add 5 more copies")).toBe("add");
    expect(resolveCartActionTypeFromSpeech("give me 3 extra")).toBe("add");
    expect(resolveCartActionTypeFromSpeech("minus 2")).toBe("remove");
    expect(resolveCartActionTypeFromSpeech("remove 1")).toBe("remove");
  });

  it("deterministic turn uses set_exact for negation instead of adding", () => {
    const session = makeSession();
    session.facilityType = "TX";
    session.lastCatalogSearch = {
      title: "Test Book",
      variantId: "gid://shopify/ProductVariant/999",
      unitPrice: "12.99",
      recordedAt: Date.now(),
    };
    addToCart(session, [
      { title: "Test Book", variant_id: "gid://shopify/ProductVariant/999", quantity: 20 },
    ]);
    const result = tryDeterministicCartTurn(
      session,
      "No, don't add more, I just want 5 total",
    );
    expect(result?.handled).toBe(true);
    expect(getCartSummary(session).totalUnits).toBe(5);
  });
});
