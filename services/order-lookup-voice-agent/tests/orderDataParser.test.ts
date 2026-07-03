import { describe, expect, it } from "vitest";
import { mapGqlOrderNode } from "../src/adapters/shopifyStorefrontAdapter.js";
import { buildOrderStatusTts } from "../src/agents/fulfillmentHandlers.js";
import {
  buildProactiveOrderSummarySpeech,
  formatOrderDateEnglish,
  parseDeepOrderData,
} from "../src/utils/orderDataParser.js";
import {
  DEEP_FETCH_EXPECTED_TTS,
  DEEP_FETCH_GQL_NODE,
} from "./fixtures/deepFetchOrder.js";
import { ORDER_22406_GQL_NODE } from "./fixtures/order22406.js";

describe("formatOrderDateEnglish", () => {
  it("formats ISO dates with ordinal day", () => {
    expect(formatOrderDateEnglish("2022-05-27T10:15:00Z")).toBe("May 27th, 2022");
    expect(formatOrderDateEnglish("2025-05-15T14:22:00Z")).toBe("May 15th, 2025");
    expect(formatOrderDateEnglish("2025-03-01T12:00:00Z")).toBe("March 1st, 2025");
    expect(formatOrderDateEnglish("2025-03-02T12:00:00Z")).toBe("March 2nd, 2025");
    expect(formatOrderDateEnglish("2025-03-03T12:00:00Z")).toBe("March 3rd, 2025");
  });

  it("passes through already-spoken timeline phrases", () => {
    expect(formatOrderDateEnglish("May 28")).toBe("May 28");
  });
});

describe("parseDeepOrderData", () => {
  it("extracts every required field from the deep-fetch GraphQL node", () => {
    const parsed = parseDeepOrderData(DEEP_FETCH_GQL_NODE);

    expect(parsed.orderNumber).toBe("#18420");
    expect(parsed.customerName).toBe("Sarah Chen");
    expect(parsed.customerEmail).toBe("sarah.chen@outlook.com");
    expect(parsed.orderPlacedAtSpoken).toBe("May 27th, 2022");
    expect(parsed.subtotalAmount).toBe("28.00 USD");
    expect(parsed.shippingFee).toBe("5.50 USD");
    expect(parsed.totalAmount).toBe("33.50 USD");
    expect(parsed.itemCount).toBe(2);
    expect(parsed.lineItems).toHaveLength(2);
    expect(parsed.isRefunded).toBe(true);
    expect(parsed.refundReason).toBe("CUSTOMER REQUESTED CANCELLATION");
    expect(parsed.refundNotificationEmail).toBe("sarah.refund@yahoo.com");
  });

  it("prefers currentSubtotalPriceSet over subtotalPriceSet", () => {
    const node = {
      ...DEEP_FETCH_GQL_NODE,
      currentSubtotalPriceSet: { shopMoney: { amount: "99.00", currencyCode: "USD" } },
      subtotalPriceSet: { shopMoney: { amount: "1.00", currencyCode: "USD" } },
    };
    expect(parseDeepOrderData(node).subtotalAmount).toBe("99.00 USD");
  });

  it("maps adapter node for order #22406 with customer email", () => {
    const mapped = mapGqlOrderNode(ORDER_22406_GQL_NODE);
    expect(mapped.customerEmail).toBe("blake.penfield@example.com");
    expect(mapped.orderPlacedAt).toBe("2025-05-15T14:22:00Z");
  });
});

describe("buildProactiveOrderSummarySpeech", () => {
  it("matches the exact fluent English proactive template", () => {
    const parsed = parseDeepOrderData(DEEP_FETCH_GQL_NODE);
    const speech = buildProactiveOrderSummarySpeech(parsed);
    expect(speech).toBe(DEEP_FETCH_EXPECTED_TTS);
  });

  it("buildOrderStatusTts produces the same proactive summary end-to-end", () => {
    const mapped = mapGqlOrderNode(DEEP_FETCH_GQL_NODE);
    const tts = buildOrderStatusTts({ status: "found", ...mapped });
    expect(tts.text).toBe(DEEP_FETCH_EXPECTED_TTS);
  });
});
