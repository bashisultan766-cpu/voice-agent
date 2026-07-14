/**
 * Privacy invariants for session persistence.
 *
 * These tests plant synthetic secrets in a fake session and verify:
 *   - serializeSessionForPersistence throws when a raw Shopify shape is present.
 *   - serialized JSON for an unverified caller does NOT contain any secret
 *     tokens (address, phone, email, tracking).
 *   - serialized JSON for a verified caller may include the shipping address
 *     inside the OrderView (only when disclosure policy allows).
 */
import { describe, expect, it } from "vitest";
import type { CallSession } from "../src/types/order.js";
import {
  assertSessionSafeForPersistence,
  isSessionSafeForPersistence,
  serializeSessionForPersistence,
} from "../src/platform/sessionSerialization.js";
import { buildOrderView, ORDER_DISCLOSURE_POLICY_VERSION } from "../src/agents/orderDisclosurePolicy.js";
import { saveSessionOrderContext } from "../src/agents/orderContextPolicy.js";

const SECRETS = {
  address: "SECRET_ADDR_XYZ",
  phone: "+15559876543",
  email: "secret@example.com",
  tracking: "TRACKSECRET99",
  pastOrder: "PAST_SECRET_1001",
} as const;

function makeSession(overrides?: Partial<CallSession>): CallSession {
  return {
    callSid: "CA_PRIV_001",
    from: "+15550000000",
    to: "+15551111111",
    phase: "active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    ...overrides,
  } as CallSession;
}

describe("sessionSerialization privacy guard", () => {
  it("blocks raw OrderStatusResult-shaped payload at any depth", () => {
    const session = makeSession();
    (session as unknown as Record<string, unknown>).__rawShopify = {
      status: "found",
      orderNumber: "1001",
      customerEmail: SECRETS.email,
      customerPhone: SECRETS.phone,
    };
    expect(() => assertSessionSafeForPersistence(session)).toThrow(/refuse to persist/);
    expect(isSessionSafeForPersistence(session)).toBe(false);
  });

  it("blocks legacy lastOrderStatusResult key even when empty", () => {
    const session = makeSession();
    (session as unknown as Record<string, unknown>).lastOrderStatusResult = {};
    expect(() => serializeSessionForPersistence(session)).toThrow(/protected marker/);
  });

  it("blocks nested admin_graphql_api_id markers", () => {
    const session = makeSession();
    (session as unknown as Record<string, unknown>).currentOrderData = {
      order_number: "1001",
      admin_graphql_api_id: "gid://shopify/Order/1",
    };
    expect(() => assertSessionSafeForPersistence(session)).toThrow(/admin_graphql_api_id/);
  });

  it("unverified caller: serialized JSON has no shipping / past-orders / phones / tracking", () => {
    const session = makeSession({ isVerifiedCaller: false });
    const view = buildOrderView(session, {
      order_number: "1001",
      customer_name: "Alex Doe",
      customer_email: SECRETS.email,
      customer_phone: SECRETS.phone,
      shipping_address: SECRETS.address,
      tracking_number: SECRETS.tracking,
      tracking_number_for_tts: SECRETS.tracking,
      past_order_history: [{ order_number: SECRETS.pastOrder }],
      totals: { total: "$10.00" },
    });
    saveSessionOrderContext(session, {
      orderNumber: "1001",
      orderView: view,
      verified: false,
    });
    const serialized = serializeSessionForPersistence(session);
    expect(serialized).not.toContain(SECRETS.address);
    expect(serialized).not.toContain(SECRETS.pastOrder);
    expect(serialized).not.toContain(SECRETS.tracking);
    // Unverified callers may still show masked email / phone via OrderView, but
    // never full raw phone digits from customer_phone.
    expect(serialized).not.toContain(SECRETS.phone);
    expect(session.sessionOrderContext?.disclosurePolicyVersion).toBe(ORDER_DISCLOSURE_POLICY_VERSION);
  });

  it("verified caller: shipping / past-orders remain inside OrderView (policy allowed)", () => {
    const session = makeSession({ isVerifiedCaller: true });
    const view = buildOrderView(session, {
      order_number: "1001",
      customer_name: "Alex Doe",
      shipping_address: SECRETS.address,
      past_order_history: [{ order_number: SECRETS.pastOrder }],
      tracking_number: SECRETS.tracking,
      totals: { total: "$10.00" },
    });
    saveSessionOrderContext(session, {
      orderNumber: "1001",
      orderView: view,
      verified: true,
    });
    const serialized = serializeSessionForPersistence(session);
    expect(serialized).toContain(SECRETS.address);
    expect(serialized).toContain(SECRETS.pastOrder);
    // Tracking must never sit inside session state directly — even verified.
    // OrderView strips tracking_number; only tracking_available flag survives.
    expect(serialized).not.toContain(SECRETS.tracking);
  });

  it("safe path: plain session with structured order serializes cleanly", () => {
    const session = makeSession({
      currentOrder: {
        orderNumber: "1001",
        customerName: "Alex Doe",
        productCount: 1,
        products: [{ name: "Book A", quantity: 1 }],
        totalAmount: "$10",
        shippingFee: "$0",
        fulfillmentStatus: "fulfilled",
        financialStatus: "paid",
        refund: { refunded: false },
        payment: {},
      },
    });
    const serialized = serializeSessionForPersistence(session);
    const parsed = JSON.parse(serialized) as CallSession;
    expect(parsed.currentOrder?.orderNumber).toBe("1001");
  });
});
