import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupOrder, clearOrderCache } from "../src/services/shopifyService.js";

describe("shopifyService", () => {
  beforeEach(() => {
    clearOrderCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns not_found when Shopify has no matching order", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    } as Response);

    const result = await lookupOrder("99999");
    expect(result.status).toBe("not_found");
  });

  it("returns api_error when Shopify is unavailable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const result = await lookupOrder("12345");
    expect(result.status).toBe("api_error");
  });

  it("maps a found order into structured fields", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        orders: [
          {
            id: 1,
            name: "#12345",
            email: "buyer@example.com",
            financial_status: "paid",
            fulfillment_status: "fulfilled",
            total_price: "25.00",
            currency: "USD",
            customer: { first_name: "Jane", last_name: "Doe" },
            line_items: [{ name: "Book A", quantity: 1 }],
            total_shipping_price_set: { shop_money: { amount: "4.99", currency_code: "USD" } },
            refunds: [],
          },
        ],
      }),
    } as Response);

    const result = await lookupOrder("12345");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.order.customerName).toBe("Jane Doe");
      expect(result.order.productCount).toBe(1);
      expect(result.order.refund.refunded).toBe(false);
    }
  });
});
