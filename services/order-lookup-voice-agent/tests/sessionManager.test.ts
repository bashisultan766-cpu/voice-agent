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
  it("keeps whitelist fields for unverified callers and nulls blacklist fields", () => {
    const session = createCallSession("CA_UNVER", "+1", "+2");
    session.isVerifiedCaller = false;
    const payload = buildActiveOrderContextPayload(SAMPLE_ORDER, session);

    expect(payload.shipping_address).toBeNull();
    expect(payload.secure_data).toBeNull();
    expect(payload.privacy_tier).toBe("unverified");
    expect(payload.physical_items).toBeTruthy();
    expect((payload.physical_items as any[])[0]?.title).toBe("Hidden Book Title");
    expect(payload.items).toBeTruthy();
    expect(payload.customer_name).toBe("Joel Moore");
    expect(payload.refund_notification_email).toBe("btazp@yahoo.com");
  });

  it("builds sanitized payload with refund notification email for verified callers", () => {
    const session = createCallSession("CA_VER", "+1", "+2");
    session.isVerifiedCaller = true;
    const payload = buildActiveOrderContextPayload(SAMPLE_ORDER, session);
    expect(payload.refund_notification_email).toBe("btazp@yahoo.com");
    expect(payload.customer_name).toBe("Joel Moore");
    expect(payload.order_number).toBe("#21698-F1");
    expect(payload.secure_data).toMatchObject({
      customer_name: "Joel Moore",
      refund_notification_email: "btazp@yahoo.com",
    });
  });

  it("persists and clears currentOrderData on the call session", () => {
    const session = createCallSession("CA_CTX", "+1", "+2");
    session.isVerifiedCaller = true;
    const payload = buildActiveOrderContextPayload(SAMPLE_ORDER, session);

    saveActiveOrderContext(session, payload);
    expect(session.currentOrderData?.refund_notification_email).toBe("btazp@yahoo.com");

    clearActiveOrderContext(session);
    expect(session.currentOrderData).toBeUndefined();
  });

  it("detects when a new spoken order number should replace context", () => {
    const session = createCallSession("CA_REPLACE", "+1", "+2");
    session.isVerifiedCaller = true;
    saveActiveOrderContext(session, buildActiveOrderContextPayload(SAMPLE_ORDER, session));

    expect(shouldReplaceOrderContext(session, "21698")).toBe(false);
    expect(shouldReplaceOrderContext(session, "99999")).toBe(true);
  });

  it("builds invisible ACTIVE ORDER CONTEXT system message", () => {
    const session = createCallSession("CA_MSG", "+1", "+2");
    session.isVerifiedCaller = true;
    const payload = buildActiveOrderContextPayload(SAMPLE_ORDER, session);
    const message = buildActiveOrderContextSystemMessage(payload);

    expect(message).toMatch(/ACTIVE ORDER CONTEXT/i);
    expect(message).toContain("btazp@yahoo.com");
    expect(message).toMatch(/Do not invent data/i);
    expect(message).toMatch(/public_data|secure_data/i);
  });
});
