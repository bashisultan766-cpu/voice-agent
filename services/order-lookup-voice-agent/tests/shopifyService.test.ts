import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrderStatus } from "../src/adapters/shopifyStorefrontAdapter.js";
import { lookupOrder, clearOrderCache } from "../src/services/shopifyService.js";

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/shopifyStorefrontAdapter.js")>();
  return {
    ...actual,
    getOrderStatus: vi.fn(),
  };
});

describe("shopifyService", () => {
  beforeEach(() => {
    clearOrderCache();
    vi.mocked(getOrderStatus).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_found when Shopify has no matching order", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({ status: "not_found" });

    const result = await lookupOrder("99999");
    expect(result.status).toBe("not_found");
    expect(getOrderStatus).toHaveBeenCalledWith("#99999", "fulfillment");
  });

  it("returns api_error when Shopify lookup fails", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "system_maintenance",
      message: "Catalog temporarily unavailable",
    });

    const result = await lookupOrder("12345");
    expect(result.status).toBe("api_error");
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
