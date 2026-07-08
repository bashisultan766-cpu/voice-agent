import { describe, expect, it } from "vitest";
import {
  buildActiveOrderContextSystemMessage,
  clearActiveOrderContext,
  saveActiveOrderContext,
  shouldReplaceOrderContext,
} from "../src/agents/sessionManager.js";
import { createCallSession } from "../src/agents/conversationOrchestrator.js";
import type { OrderStatusResult } from "../src/adapters/shopifyStorefrontAdapter.js";
import { buildActiveOrderContextPayload } from "../src/adapters/llmToolExecutor.js";

const SAMPLE_ORDER: OrderStatusResult = {
  status: "found",
  orderNumber: "#21698-F1",
  customerName: "Joel Moore",
  refundStatus: "REFUNDED",
  refundReason: "OUT OF STOCK",
  refundNotificationEmail: "btazp@yahoo.com",
  fulfillmentStatus: "unfulfilled",
  shippingAddress: "123 Facility Rd, Unit 4B",
  lineItems: [{ title: "Hidden Book Title", quantity: 1 }],
};

describe("sessionManager active order context", () => {
  it("strips restricted line-item detail for unverified callers", () => {
    const session = createCallSession("CA_UNVER", "+1", "+2");
    session.isVerifiedCaller = false;
    const payload = buildActiveOrderContextPayload(SAMPLE_ORDER, session);

    expect(payload.shipping_address).toBeNull();
    expect(payload.physical_items).toBeNull();
    expect(payload.items).toBeNull();
    expect(payload.customer_name).toBe("Joel Moore");
    expect(payload.refund_notification_email).toBe("btazp@yahoo.com");
  });

  it("builds sanitized payload with refund notification email", () => {
    const payload = buildActiveOrderContextPayload(SAMPLE_ORDER);
    expect(payload.refund_notification_email).toBe("btazp@yahoo.com");
    expect(payload.order_number).toBe("#21698-F1");
  });

  it("persists and clears currentOrderData on the call session", () => {
    const session = createCallSession("CA_CTX", "+1", "+2");
    const payload = buildActiveOrderContextPayload(SAMPLE_ORDER);

    saveActiveOrderContext(session, payload);
    expect(session.currentOrderData?.refund_notification_email).toBe("btazp@yahoo.com");

    clearActiveOrderContext(session);
    expect(session.currentOrderData).toBeUndefined();
  });

  it("detects when a new spoken order number should replace context", () => {
    const session = createCallSession("CA_REPLACE", "+1", "+2");
    saveActiveOrderContext(session, buildActiveOrderContextPayload(SAMPLE_ORDER));

    expect(shouldReplaceOrderContext(session, "21698")).toBe(false);
    expect(shouldReplaceOrderContext(session, "99999")).toBe(true);
  });

  it("builds invisible ACTIVE ORDER CONTEXT system message", () => {
    const payload = buildActiveOrderContextPayload(SAMPLE_ORDER);
    const message = buildActiveOrderContextSystemMessage(payload);

    expect(message).toMatch(/ACTIVE ORDER CONTEXT/i);
    expect(message).toContain("btazp@yahoo.com");
    expect(message).toMatch(/Do not invent data/i);
  });
});
