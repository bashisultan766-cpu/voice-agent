import { describe, expect, it } from "vitest";
import { mapGqlOrderNode } from "../src/adapters/shopifyStorefrontAdapter.js";
import { buildOrderStatusTts } from "../src/agents/fulfillmentHandlers.js";
import {
  extractRefundNotificationDate,
  extractRefundNotificationEmail,
  extractTimelineRefundReason,
} from "../src/adapters/orderFieldExtractors.js";
import {
  ORDER_22406_EXPECTED,
  ORDER_22406_GQL_NODE,
} from "./fixtures/order22406.js";

describe("order #22406 deep timeline extraction", () => {
  const events = ORDER_22406_GQL_NODE.events.edges.map((e) => e.node);

  it("extracts exact timeline refund reason", () => {
    expect(extractTimelineRefundReason(events)).toBe(
      "OUT OF STOCK - ISSUE REFUND VIA PAYPAL",
    );
  });

  it("extracts refund notification email from timeline parenthetical", () => {
    expect(extractRefundNotificationEmail(events, [])).toBe("btazp@yahoo.com");
  });

  it("extracts refund date phrase from timeline", () => {
    expect(
      extractRefundNotificationDate(events, {
        processedAt: ORDER_22406_GQL_NODE.processedAt,
        isRefunded: true,
      }),
    ).toBe("May 28");
  });

  it("maps GraphQL node with placement date and timeline fields", () => {
    const mapped = mapGqlOrderNode(ORDER_22406_GQL_NODE);
    expect(mapped.orderNumber).toBe(ORDER_22406_EXPECTED.orderNumber);
    expect(mapped.customerName).toBe(ORDER_22406_EXPECTED.customerName);
    expect(mapped.customerEmail).toBe(ORDER_22406_EXPECTED.customerEmail);
    expect(mapped.orderPlacedAt).toBe(ORDER_22406_EXPECTED.orderPlacedAt);
    expect(mapped.refundReason).toBe(ORDER_22406_EXPECTED.refundReason);
    expect(mapped.refundNotificationEmail).toBe(
      ORDER_22406_EXPECTED.refundNotificationEmail,
    );
    expect(mapped.refundDate).toBe(ORDER_22406_EXPECTED.refundDate);
    expect(mapped.shippingFee).toBe(ORDER_22406_EXPECTED.shippingFee);
  });

  it("buildOrderStatusTts recites full chronological story without hallucination", () => {
    const mapped = mapGqlOrderNode(ORDER_22406_GQL_NODE);
    const tts = buildOrderStatusTts({ status: "found", ...mapped });

    expect(tts.text).toContain("Blake Penfield");
    expect(tts.text).toMatch(/placed on May 15th, 2025/i);
    expect(tts.text).toContain("blake.penfield@example.com");
    expect(tts.text).toContain("Your order contains 1 item");
    expect(tts.text).toMatch(/The books cost/i);
    expect(tts.text).toMatch(/shipping was/i);
    expect(tts.text).toMatch(/making the total/i);
    expect(tts.text).toContain("OUT OF STOCK - ISSUE REFUND VIA PAYPAL");
    expect(tts.text).toContain("btazp@yahoo.com");
    expect(tts.text).not.toMatch(/refund confirmation email was sent to blake\.penfield@example\.com/i);
    expect(tts.text).not.toMatch(/\bfake\b/i);
  });
});
