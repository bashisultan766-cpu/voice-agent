import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrderStatus } from "../src/adapters/shopifyStorefrontAdapter.js";
import { lookupOrder, clearOrderCache } from "../src/services/shopifyService.js";

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", () => ({
  getOrderStatus: vi.fn(),
}));

describe("shopifyService", () => {
  beforeEach(() => {
    clearOrderCache();
    vi.mocked(getOrderStatus).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_found when Shopify has no matching order after retry", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({ status: "not_found" });

    const result = await lookupOrder("99999");
    expect(result.status).toBe("not_found");
    expect(getOrderStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getOrderStatus).toHaveBeenCalledWith("#99999", "fulfillment");
  });

  it("retries once when Shopify initially returns not_found then finds the order", async () => {
    vi.mocked(getOrderStatus)
      .mockResolvedValueOnce({ status: "not_found", searchedNumber: "#21698" })
      .mockResolvedValueOnce({
        status: "found",
        orderNumber: "#21698-F1",
        customerName: "Joel Moore",
      });

    const result = await lookupOrder("21698");
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.order.orderNumber).toBe("#21698-F1");
    expect(getOrderStatus.mock.calls.length).toBe(2);
  });

  it("returns api_error when Shopify lookup fails", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "system_maintenance",
      message: "Catalog temporarily unavailable",
    });

    const result = await lookupOrder("12345");
    expect(result.status).toBe("api_error");
    expect(getOrderStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not cache not_found — second lookup hits Shopify again", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({ status: "not_found" });

    await lookupOrder("21698");
    await lookupOrder("21698");
    expect(vi.mocked(getOrderStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not cache transient order lookup failures", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({ status: "api_error", message: "down" });

    await lookupOrder("12345");
    const callsAfterFirst = vi.mocked(getOrderStatus).mock.calls.length;

    await lookupOrder("12345", { bypassCache: true });
    expect(vi.mocked(getOrderStatus).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("maps a found order into structured fields via GraphQL lookup", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "found",
      orderNumber: "#12345",
      customerName: "Jane Doe",
      financialStatus: "PAID",
      fulfillmentStatus: "fulfilled",
      totalAmount: "25.00 USD",
      shippingFee: "4.99 USD",
      itemCount: 1,
      lineItems: [{ title: "Book A", quantity: 1 }],
      cardLast4: "4242",
      cardBrand: "Visa",
      paymentGateway: "Shopify Payments",
    });

    const result = await lookupOrder("12345");
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.order.orderNumber).toBe("#12345");
    expect(result.order.customerName).toBe("Jane Doe");
    expect(result.order.products).toEqual([{ name: "Book A", quantity: 1 }]);
    expect(result.order.payment.cardLast4).toBe("4242");
  });
});
