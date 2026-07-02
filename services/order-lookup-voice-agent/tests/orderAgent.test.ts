import { describe, it, expect } from "vitest";
import {
  buildOrderVoiceScript,
  extractOrderNumberFromSpeech,
  isValidOrderNumberFormat,
  normalizeOrderNumber,
  ORDER_NOT_FOUND_MESSAGE,
  SHOPIFY_DOWN_MESSAGE,
} from "../src/utils/formatter.js";
import { extractLast4, safeCustomerFacingOrder } from "../src/utils/security.js";
import type { StructuredOrder } from "../src/types/order.js";
import { handleAgentTurn, createCallSession } from "../src/agents/orderAgent.js";

const sampleOrder: StructuredOrder = {
  orderNumber: "#45678",
  customerName: "Maria Johnson",
  productCount: 2,
  products: [
    { name: "The Great Gatsby", quantity: 1 },
    { name: "To Kill a Mockingbird", quantity: 1 },
  ],
  totalAmount: "32.50 USD",
  shippingFee: "5.99 USD",
  fulfillmentStatus: "fulfilled",
  financialStatus: "paid",
  refund: { refunded: false },
  payment: { cardLast4: "4242", cardBrand: "Visa" },
};

describe("order number validation", () => {
  it("normalizes spoken order numbers", () => {
    expect(normalizeOrderNumber("45678")).toBe("#45678");
    expect(normalizeOrderNumber("#45678")).toBe("#45678");
    expect(isValidOrderNumberFormat("#45678")).toBe(true);
    expect(isValidOrderNumberFormat("123")).toBe(false);
  });

  it("extracts order numbers from speech", () => {
    expect(extractOrderNumberFromSpeech("My order number is 45678")).toBe("#45678");
    expect(extractOrderNumberFromSpeech("four five six seven eight")).toBe("#45678");
  });
});

describe("voice script formatter", () => {
  it("builds full structured voice response for valid order", () => {
    const script = buildOrderVoiceScript(sampleOrder);
    expect(script).toContain("Maria");
    expect(script).toContain("items");
    expect(script).toContain("32");
    expect(script).toContain("shipping");
    expect(script).toContain("refunded");
    expect(script).toContain("four, two, four, two");
    expect(script).toContain("anything else");
  });

  it("includes refund explanation when refunded", () => {
    const refunded: StructuredOrder = {
      ...sampleOrder,
      refund: {
        refunded: true,
        reason: "Facility rejected delivery",
        refundEmail: "maria@example.com",
      },
      fulfillmentStatus: "unfulfilled",
    };
    const script = buildOrderVoiceScript(refunded);
    expect(script).toContain("sorry");
    expect(script).toContain("refunded");
    expect(script).toContain("Facility rejected delivery");
    expect(script).toContain("maria@example.com");
  });

  it("skips missing refund data gracefully", () => {
    const refunded: StructuredOrder = {
      ...sampleOrder,
      refund: { refunded: true },
    };
    const script = buildOrderVoiceScript(refunded);
    expect(script).toContain("refunded");
    expect(script).not.toContain("reason on file");
    expect(script).not.toContain("confirmation was sent");
  });
});

describe("security", () => {
  it("only exposes last four card digits", () => {
    expect(extractLast4("xxxxxxxxxxxx4242")).toBe("4242");
    expect(extractLast4("123")).toBeUndefined();
  });

  it("withholds email unless refund exists", () => {
    const safe = safeCustomerFacingOrder({
      ...sampleOrder,
      refund: { refunded: false, refundEmail: "hidden@example.com" },
    });
    expect(safe.refund.refundEmail).toBeUndefined();
  });
});

describe("agent QA flows", () => {
  it("handles invalid order with retry message", async () => {
    const session = createCallSession("CA123", "+15550001", "+15550002");
    session.phase = "awaiting_order_number";
    const result = await handleAgentTurn(session, "hello there");
    expect(result.speech).toMatch(/valid order number|didn't catch/i);
    expect(session.phase).toBe("awaiting_order_number");
  });

  it("uses not found message for missing orders", () => {
    expect(ORDER_NOT_FOUND_MESSAGE).toContain("couldn't find");
  });

  it("uses shopify down fallback message", () => {
    expect(SHOPIFY_DOWN_MESSAGE).toContain("trouble reaching");
  });
});
