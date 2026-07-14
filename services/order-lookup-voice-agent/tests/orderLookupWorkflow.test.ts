import { describe, expect, it } from "vitest";
import {
  applySessionCartQuantity,
  checkFacilityCompliance,
  isOrderLookupInsistenceUtterance,
  isTransientOrderLookupStatus,
  speechForOrderLookupResult,
} from "../src/agents/orderLookupWorkflow.js";
import type { CallSession } from "../src/types/order.js";

function makeSession(): CallSession {
  return {
    callSid: "CA_COMPLIANCE",
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
  };
}

describe("orderLookupWorkflow", () => {
  it("detects caller insistence on the order number", () => {
    expect(isOrderLookupInsistenceUtterance("this is the correct order number please find it")).toBe(
      true,
    );
    expect(isOrderLookupInsistenceUtterance("order number 12345")).toBe(false);
  });

  it("uses order-specific speech for transient lookup failures", () => {
    const speech = speechForOrderLookupResult({ status: "api_error", message: "down" });
    expect(speech).toMatch(/hiccup pulling that order/i);
    expect(speech).not.toMatch(/catalog system/i);
  });

  it("uses retry speech when caller insists after a transient failure", () => {
    const speech = speechForOrderLookupResult(
      { status: "api_error", message: "down" },
      { insistence: true },
    );
    expect(speech).toMatch(/look that order up again/i);
  });

  it("classifies transient statuses", () => {
    expect(isTransientOrderLookupStatus("api_error")).toBe(true);
    expect(isTransientOrderLookupStatus("found")).toBe(false);
  });
});

describe("facility compliance engine", () => {
  it("flags restricted_state_fl when facility is Florida", () => {
    const result = checkFacilityCompliance({
      bookTitle: "Restricted Title",
      facilityType: "Florida",
      tags: ["restricted_state_fl", "paperback"],
    });
    expect(result.status).toBe("restricted");
    expect(result.speech).toMatch(/flagged as restricted for Florida/i);
  });

  it("blocks cart add when restricted tag matches facility", () => {
    const session = makeSession();
    session.lastCatalogSearch = {
      title: "Restricted Title",
      variantId: "gid://shopify/ProductVariant/1",
      unitPrice: "9.99",
      recordedAt: Date.now(),
      tags: ["restricted_state_fl"],
      metafields: [],
    };
    const blocked = applySessionCartQuantity(
      session,
      {
        title: "Restricted Title",
        variant_id: "gid://shopify/ProductVariant/1",
        unit_price: "9.99",
      },
      1,
      "add",
      { facilityType: "FL" },
    );
    expect(blocked.complianceBlocked).toBe(true);
    expect(blocked.cart).toHaveLength(0);
    expect(blocked.message).toMatch(/Restricted Title/i);
    expect(blocked.message).toMatch(/restricted for FL/i);
  });

  it("asks for facility type when unknown before add", () => {
    const session = makeSession();
    const blocked = applySessionCartQuantity(
      session,
      {
        title: "Any Book",
        variant_id: "gid://shopify/ProductVariant/2",
      },
      1,
      "add",
    );
    expect(blocked.needsFacilityInfo).toBe(true);
    expect(blocked.complianceBlocked).toBe(true);
    expect(blocked.message).toMatch(/facility type on file/i);
  });

  it("allows approved add when facility is known and no restriction matches", () => {
    const session = makeSession();
    session.lastCatalogSearch = {
      title: "Open Title",
      variantId: "gid://shopify/ProductVariant/3",
      recordedAt: Date.now(),
      tags: ["restricted_state_fl"],
      metafields: [],
    };
    const ok = applySessionCartQuantity(
      session,
      {
        title: "Open Title",
        variant_id: "gid://shopify/ProductVariant/3",
      },
      2,
      "add",
      { facilityType: "Texas" },
    );
    expect(ok.complianceBlocked).toBeFalsy();
    expect(ok.cart).toHaveLength(1);
    expect(ok.cart[0]?.quantity).toBe(2);
    expect(ok.cart[0]?.tags).toEqual(["restricted_state_fl"]);
    expect(ok.message).toMatch(/2 copies of Open Title/i);
  });

  it("re-checks stamped cart-line tags on later increase without catalog search", () => {
    const session = makeSession();
    session.facilityType = "FL";
    session.shoppingCart = [
      {
        variantId: "gid://shopify/ProductVariant/9",
        productId: "gid://shopify/Product/9",
        title: "Stamped Restricted",
        quantity: 1,
        unitPrice: "8.00",
        tags: ["restricted_state_fl"],
      },
    ];
    session.lastCatalogSearch = undefined;
    const blocked = applySessionCartQuantity(
      session,
      {
        title: "Stamped Restricted",
        variant_id: "gid://shopify/ProductVariant/9",
      },
      1,
      "add",
    );
    expect(blocked.complianceBlocked).toBe(true);
    expect(blocked.cart[0]?.quantity).toBe(1);
    expect(blocked.message).toMatch(/Stamped Restricted/i);
  });
});
