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

  it("buildOrderStatusTts gives concise initial response without data dump", () => {
    const mapped = mapGqlOrderNode(ORDER_22406_GQL_NODE);
    const tts = buildOrderStatusTts({ status: "found", ...mapped });

    expect(tts.text).toMatch(/^Your order 22406 is Refunded as of /);
    expect(tts.text).not.toContain("Blake Penfield");
    expect(tts.text).not.toContain("Your order contains");
    expect(tts.text).not.toContain("OUT OF STOCK");
    expect(tts.text).not.toMatch(/\bfake\b/i);
  });
});
