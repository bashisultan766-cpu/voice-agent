import { describe, expect, it } from "vitest";
import { toolResultForLlm } from "../src/adapters/llmToolExecutor.js";
import type { LlmToolExecutionRecord } from "../src/adapters/llmToolExecutor.js";

describe("toolResultForLlm order shaping", () => {
  it("emits snake_case fields for order status with null placeholders", () => {
    const record: LlmToolExecutionRecord = {
      tool: "get_shopify_order_status",
      args: { orderNumber: "21698" },
      ok: true,
      status: "found",
      elapsedMs: 10,
      data: {
        status: "found",
        orderNumber: "#21698-F1",
        customerName: "Joel Moore",
        totalAmount: "96.00 USD",
        shippingFee: "5.00 USD",
        refundStatus: "REFUNDED",
        refundReason: "OUT OF STOCK",
        refundNotificationEmail: "zzyxx2002@yahoo.com",
        paymentGateway: "PayPal Express Checkout",
        lineItems: [{ title: "The Holy Bible - King James Version", quantity: 1 }],
      },
    };

    const parsed = JSON.parse(toolResultForLlm(record)) as {
      data: Record<string, unknown>;
      instructions: string;
    };

    expect(parsed.data.customer_name).toBe("Joel Moore");
    expect(parsed.data.refund_notification_email).toBe("zzyxx2002@yahoo.com");
    expect(parsed.data.payment_gateway).toBe("PayPal Express Checkout");
    expect(parsed.data.payment_method_last4).toBeNull();
    expect(parsed.instructions).toMatch(/never invent/i);
  });
});
