import { describe, expect, it } from "vitest";
import {
  filterOrderContextForVerification,
  orderUtteranceNeedsFreshLookup,
} from "../src/agents/orderContextPrivacy.js";
import { shouldSkipToolReinvoke } from "../src/sovereign/activeSession.js";
import type { ActiveSession } from "../src/sovereign/activeSession.js";

describe("orderContextPrivacy", () => {
  it("strips only shipping address for unverified callers", () => {
    const filtered = filterOrderContextForVerification(
      {
        customer_name: "Jamaica Thompson",
        customer_email: "jamaica@example.com",
        shipping_address: "123 Main St",
        physical_items: [{ title: "Book" }],
        total_amount: "$42.00",
        shipping_amount: "$4.99",
        events: ["Order confirmation email was sent"],
        payment_method: "Visa ending in 1302",
        payment_method_last4: "1302",
      },
      false,
    );
    expect(filtered.customer_name).toBe("Jamaica Thompson");
    expect(filtered.customer_email).toBe("jamaica@example.com");
    expect(filtered.shipping_address).toBeNull();
    expect(filtered.physical_items).toEqual([{ title: "Book" }]);
    expect(filtered.total_amount).toBe("$42.00");
    expect(filtered.events).toEqual(["Order confirmation email was sent"]);
    expect(filtered.payment_method_last4).toBe("1302");
    expect(filtered.privacy_tier).toBe("unverified");
  });

  it("detects when a fresh Shopify lookup is needed", () => {
    expect(
      orderUtteranceNeedsFreshLookup("what is the total amount", { customer_name: "A" }),
    ).toBe(true);
    expect(
      orderUtteranceNeedsFreshLookup("what is the total amount", {
        customer_name: "A",
        total_amount: "$42.00",
      }),
    ).toBe(false);
  });
});

describe("shouldSkipToolReinvoke", () => {
  const active: ActiveSession = {
    callSid: "CA",
    currentState: "order_active",
    cachedIntent: "order",
    lastSpokenPayload: {
      kind: "order_status",
      speech: "found",
      toolName: "get_shopify_order_status",
      intentKey: "order",
      capturedAt: Date.now(),
    },
    spatialIndex: [],
    awaitingClarification: null,
    preferredVoice: "ElevenLabs",
    lastDictationIndex: -1,
    lastSpokenIndex: -1,
    agentRelayState: "LISTENING",
    isNotepadReady: false,
  };

  it("allows re-fetch when the caller asks for a missing field", () => {
    expect(
      shouldSkipToolReinvoke(active, "order", "get_shopify_order_status", {
        userMessage: "what is the shipping fee",
        orderContext: { customer_name: "A" },
      }),
    ).toBe(false);
  });

  it("allows re-fetch when no order context is loaded yet", () => {
    expect(
      shouldSkipToolReinvoke(active, "order", "get_shopify_order_status", {
        userMessage: "21796",
        orderContext: {},
      }),
    ).toBe(false);
  });

  it("allows re-fetch when caller insists the order number is correct", () => {
    expect(
      shouldSkipToolReinvoke(active, "order", "get_shopify_order_status", {
        userMessage: "this is the correct order number please find it",
        orderContext: { customer_name: "A" },
      }),
    ).toBe(false);
  });

  it("still skips identical order re-fetch when context is complete", () => {
    expect(
      shouldSkipToolReinvoke(active, "order", "get_shopify_order_status", {
        userMessage: "repeat the order status",
        orderContext: { customer_name: "A", fulfillment_status: "fulfilled" },
      }),
    ).toBe(true);
  });
});
