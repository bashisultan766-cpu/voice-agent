import { describe, it, expect } from "vitest";
import {
  planInstantConfirmation,
  planInstantFiller,
  planOrderLookupResponse,
  planLookupError,
  flattenPlan,
} from "../src/agents/responsePlanner.js";
import type { StructuredOrder } from "../src/types/order.js";

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

describe("responsePlanner", () => {
  it("emits tool-specific instant filler", () => {
    const orderFiller = planInstantFiller("get_shopify_order_status");
    expect(orderFiller.text).toContain("pull that up");
    expect(orderFiller.kind).toBe("filler");

    const searchFiller = planInstantFiller("search_shopify_book_by_title");
    expect(searchFiller.text).toContain("check the catalog");
  });

  it("emits instant confirmation with first name", () => {
    const chunk = planInstantConfirmation(sampleOrder);
    expect(chunk.text).toContain("Maria");
    expect(chunk.kind).toBe("confirmation");
  });

  it("plans chunked summary instead of one dump", () => {
    const plan = planOrderLookupResponse(sampleOrder);
    expect(plan.chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of plan.chunks) {
      expect(chunk.text.split(/\s+/).length).toBeLessThanOrEqual(16);
    }
    expect(plan.chunks.some((c) => c.kind === "closing")).toBe(true);
  });

  it("uses empathetic tone chunks for refunds", () => {
    const refunded: StructuredOrder = {
      ...sampleOrder,
      refund: {
        refunded: true,
        reason: "Facility rejected delivery",
        refundEmail: "maria@example.com",
      },
    };
    const plan = planOrderLookupResponse(refunded);
    expect(plan.tone).toBe("empathetic");
    expect(flattenPlan(plan)).toContain("sorry");
    expect(flattenPlan(plan)).toContain("refunded");
  });

  it("handles not found with soft error chunk", () => {
    const plan = planLookupError({ status: "not_found" });
    expect(plan.chunks[0].kind).toBe("error");
    expect(plan.chunks[0].text).toMatch(/not seeing/i);
  });
});
