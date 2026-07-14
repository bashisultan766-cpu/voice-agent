import { describe, expect, it } from "vitest";
import type { CallSession } from "../src/types/order.js";
import { applySessionCartQuantity } from "../src/agents/orderLookupWorkflow.js";
import { ensureShoppingCart, getCartState, updateCartItemQuantity } from "../src/agents/cartManager.js";
import {
  checkLogisticsFeasibility,
  evaluateInventoryUrgency,
  verifyStockAvailability,
} from "../src/agents/logisticsIntelligence.js";
import {
  CheckoutManager,
  initiateCheckoutBatch,
} from "../src/agents/paymentCheckoutFlow.js";

function makeSession(callSid = "CA_LOG"): CallSession {
  return {
    callSid,
    from: "+1",
    to: "+2",
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    facilityType: "federal",
  } as CallSession;
}

const VARIANT = "gid://shopify/ProductVariant/9001";

describe("Logistics Intelligence Layer", () => {
  it("Urgency Guardrail — low stock warns and stamps temporary reservation", () => {
    const session = makeSession("CA_LOW");
    session.lastCatalogSearch = {
      title: "Dad to Son",
      variantId: VARIANT,
      unitPrice: "12.99",
      recordedAt: Date.now(),
      quantity: 2,
    };

    const result = applySessionCartQuantity(
      session,
      {
        variant_id: VARIANT,
        title: "Dad to Son",
        unit_price: "12.99",
        inventoryQuantity: 2,
      },
      1,
      "add",
      { facilityType: "federal" },
    );

    expect(result.inventoryBlocked).toBeFalsy();
    expect(result.temporaryReservation).toBe(true);
    expect(result.message).toMatch(/temporary reservation|only have 2/i);
    const line = ensureShoppingCart(session)[0];
    expect(line?.temporaryReservation).toBe(true);
    expect(line?.inventoryQuantity).toBe(2);
  });

  it("Urgency Guardrail — out of stock blocks add and suggests alternatives", () => {
    const session = makeSession("CA_OOS");
    session.lastCatalogSearch = {
      title: "Gone Book",
      variantId: VARIANT,
      unitPrice: "9.99",
      recordedAt: Date.now(),
      quantity: 0,
    };

    const result = applySessionCartQuantity(
      session,
      { variant_id: VARIANT, title: "Gone Book", inventoryQuantity: 0 },
      1,
      "add",
      { facilityType: "federal" },
    );

    expect(result.inventoryBlocked).toBe(true);
    expect(result.suggestAlternatives).toBe(true);
    expect(result.message).toMatch(/out of stock|pre-order|similar/i);
    expect(getCartState(session).totalUnits).toBe(0);
  });

  it("check_logistics_feasibility — package_restriction removes non-shipable title", () => {
    const check = checkLogisticsFeasibility(
      {
        title: "Heavy Atlas",
        metafields: [
          { namespace: "custom", key: "package_restriction", value: "non_shipable" },
        ],
      },
      "federal",
    );
    expect(check.ok).toBe(false);
    expect(check.speech).toContain(
      "I'm afraid I cannot process the payment for Heavy Atlas as it does not meet the facility's packaging requirements",
    );
  });

  it("Atomic Finality — stock-out between cart-add and checkout-batch updates cart without crash", () => {
    const session = makeSession("CA_STOCKOUT");
    const add = applySessionCartQuantity(
      session,
      {
        variant_id: VARIANT,
        title: "Volatile Title",
        unit_price: "15.00",
        inventoryQuantity: 5,
      },
      2,
      "add",
      { facilityType: "federal" },
    );
    expect(add.inventoryBlocked).toBeFalsy();
    expect(getCartState(session).totalUnits).toBe(2);

    // Simulate stock-out after add, before payment batch (CheckoutManager double-check).
    const liveInventory = { [VARIANT]: 0 };
    const batch = initiateCheckoutBatch(
      session,
      [{ variant_id: VARIANT, title: "Volatile Title", quantity: 2 }],
      { startEmailCapture: false, liveInventory },
    );
    expect(batch.ok).toBe(false);
    if (!batch.ok) {
      expect(batch.message).toMatch(/inventory|available|cart|no longer/i);
      expect(batch.cartUpdated).toBe(true);
    }
    expect(getCartState(session).totalUnits).toBe(0);
    expect(() => getCartState(session)).not.toThrow();
    expect(
      CheckoutManager.verifyStockAvailability(session, null, { liveInventory }).ok,
    ).toBe(false);
  });

  it("CheckoutManager initiateCheckoutBatch — double-check keeps remaining shipable lines", () => {
    const session = makeSession("CA_MIX");
    const a = "gid://shopify/ProductVariant/1";
    const b = "gid://shopify/ProductVariant/2";

    applySessionCartQuantity(
      session,
      {
        variant_id: a,
        title: "Keep Me",
        unit_price: "10.00",
        inventoryQuantity: 10,
      },
      1,
      "add",
      { facilityType: "federal" },
    );

    // ComplianceEngine (logistics sub-layer) blocks non_shipable at add-time.
    // Seed a stale cart line so CheckoutManager batch gate still filters one rejection point at payment.
    updateCartItemQuantity(
      session,
      {
        variant_id: b,
        title: "Drop Me",
        unit_price: "10.00",
        inventoryQuantity: 10,
        metafields: [
          { namespace: "custom", key: "package_restriction", value: "non_shipable" },
        ],
      },
      1,
      "add",
    );

    const result = initiateCheckoutBatch(
      session,
      [
        { variant_id: a, title: "Keep Me", quantity: 1 },
        { variant_id: b, title: "Drop Me", quantity: 1 },
      ],
      {
        startEmailCapture: false,
        liveInventory: { [a]: 10, [b]: 10 },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.logisticsGated).toBe(true);
      expect(result.stockVerified).toBe(true);
      expect(result.batch).toHaveLength(1);
      expect(result.batch[0]?.title).toBe("Keep Me");
      expect(result.speech).toMatch(/packaging requirements/i);
    }
    expect(getCartState(session).shoppingCart.map((l) => l.title)).toEqual(["Keep Me"]);
  });

  it("evaluateInventoryUrgency thresholds", () => {
    expect(evaluateInventoryUrgency(0, "X", 1).status).toBe("out_of_stock");
    expect(evaluateInventoryUrgency(2, "X", 1).status).toBe("low_stock");
    expect(evaluateInventoryUrgency(2, "X", 1).temporaryReservation).toBe(true);
    expect(evaluateInventoryUrgency(5, "X", 1).status).toBe("ok");
  });
});
