import { describe, expect, it } from "vitest";
import {
  compressHistoryLineItems,
  formatOrderMonthYear,
  mapHistoryOrderStatus,
  minifyCustomerHistoryOrders,
} from "../src/adapters/shopifyStorefrontAdapter.js";

describe("customer history minification", () => {
  it("formats ISO dates as Month Year", () => {
    expect(formatOrderMonthYear("2026-04-15T12:00:00Z")).toBe("April 2026");
    expect(formatOrderMonthYear("2025-06-01T00:00:00Z")).toBe("June 2025");
  });

  it("maps refunded and fulfilled statuses", () => {
    expect(mapHistoryOrderStatus("REFUNDED", "Fulfilled")).toBe("Refunded");
    expect(mapHistoryOrderStatus("PAID", "Fulfilled")).toBe("Fulfilled");
  });

  it("compresses line items to comma-separated titles", () => {
    expect(
      compressHistoryLineItems([
        { node: { title: "Harry Potter", quantity: 1 } },
        { node: { title: "Study Bible", quantity: 2 } },
      ]),
    ).toBe("Harry Potter, Study Bible x2");
  });

  it("minifies 10+ orders with monthYear and no nested item arrays", () => {
    const edges = Array.from({ length: 12 }, (_, i) => ({
      node: {
        name: `#${1000 + i}`,
        createdAt: new Date(Date.UTC(2026, i % 12, 10)).toISOString(),
        displayFinancialStatus: i === 3 ? "REFUNDED" : "PAID",
        displayFulfillmentStatus: "Fulfilled",
        totalPriceSet: { shopMoney: { amount: "24.99", currencyCode: "USD" } },
        lineItems: {
          edges: [{ node: { title: `Book ${i + 1}`, quantity: 1 } }],
        },
      },
    }));

    const orders = minifyCustomerHistoryOrders(edges);
    expect(orders).toHaveLength(12);
    expect(orders[0]).toMatchObject({
      orderNumber: "#1000",
      monthYear: "January 2026",
      totalAmount: "24.99 USD",
      status: "Fulfilled",
      items: "Book 1",
    });
    expect(orders[3]?.status).toBe("Refunded");
    expect(typeof orders[0]?.items).toBe("string");
    expect(JSON.stringify(orders).length).toBeLessThan(4000);
  });
});
