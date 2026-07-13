import { describe, expect, it } from "vitest";
import {
  filterOrderContextForVerification,
  orderUtteranceNeedsFreshLookup,
} from "../src/agents/orderContextPrivacy.js";
import { shouldSkipToolReinvoke } from "../src/sovereign/activeSession.js";
import type { ActiveSession } from "../src/sovereign/activeSession.js";

describe("orderContextPrivacy", () => {
  it("keeps public_data and strips secure fields for unverified callers", () => {
    const filtered = filterOrderContextForVerification(
      {
        public_data: {
          order_number: "1234",
          fulfillment_status: "FULFILLED",
          tracking_number: "1Z999",
        },
        secure_data: {
          customer_email: "jamaica@example.com",
          shipping_address: "123 Main St",
          payment_method_last4: "1302",
        },
        customer_name: "Jamaica Thompson",
        customer_email: "jamaica@example.com",
        shipping_address: "123 Main St",
        physical_items: [{ title: "Book" }],
        total_amount: "$42.00",
        shipping_amount: "$4.99",
        events: ["Jessica Glass: manually marked $40.00 as paid"],
        note: "Account Deposit $65.00",
        tags: ["account-deposit", "manual"],
        transactions: [{ kind: "sale", gateway: "manual", amount: "40.00" }],
        payment_method: "Visa ending in 1302",
        payment_method_last4: "1302",
        tracking_number: "1Z999",
        fulfillment_status: "FULFILLED",
      },
      false,
    );
    expect(filtered.public_data).toMatchObject({
      order_number: "1234",
      tracking_number: "1Z999",
    });
    expect(filtered.secure_data).toBeNull();
    expect(filtered.customer_name).toBeNull();
    expect(filtered.customer_email).toBeNull();
    expect(filtered.shipping_address).toBeNull();
    expect(filtered.total_amount).toBeNull();
    expect(filtered.payment_method_last4).toBeNull();
    expect(filtered.events).toEqual(["Jessica Glass: manually marked $40.00 as paid"]);
    expect(filtered.tags).toEqual(["account-deposit", "manual"]);
    expect(filtered.note).toBe("Account Deposit $65.00");
    expect(filtered.past_order_history).toBeNull();
    expect(filtered.tracking_number).toBe("1Z999");
    expect(filtered.fulfillment_status).toBe("FULFILLED");
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
        orderContext: { customer_name: "A", total_amount: "$10" },
      }),
    ).toBe(false);
  });
});
