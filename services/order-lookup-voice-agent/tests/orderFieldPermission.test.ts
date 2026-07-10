import { describe, expect, it } from "vitest";
import { createCallSession } from "../src/agents/orderAgent.js";
import { applyCallerVerificationFromOrder } from "../src/agents/callerVerification.js";
import { filterOrderContextForVerification } from "../src/agents/orderContextPrivacy.js";
import {
  buildOrderDetailSpeech,
  detectRequestedOrderFields,
} from "../src/agents/orderDetailBuilder.js";
import {
  buildMonthDrillDownSpeech,
  buildUnverifiedOrderHistorySpeech,
  buildVerifiedHistoryOverviewSpeech,
  setOrderHistoryContext,
} from "../src/agents/orderHistoryFlow.js";
import { canRevealOrderField } from "../src/agents/verificationGate.js";
import type { CallSession } from "../src/types/order.js";

const ORDER_CONTEXT = {
  order_number: "48065",
  customer_name: "Frederick Marcalus",
  shipping_address: "123 Main St, Austin TX",
  physical_items: [{ title: "Healing Book", quantity: 1, price: "$12.00 USD" }],
  item_count: 1,
  subtotal_amount: "$12.00 USD",
  shipping_amount: "$5.00 USD",
  total_amount: "$17.00 USD",
  fulfillment_status: "fulfilled",
  tracking_number: "1Z999AA10123456784",
  tracking_company: "UPS",
  payment_method: "Visa ending in 4242",
  payment_gateway: "shopify_payments",
  financial_status: "paid",
  order_confirmation_email: "fred@example.com",
  customer_phone: "+15551234567",
};

function seedSession(callSid: string, verified: boolean): CallSession {
  const phone = verified ? "+15551234567" : "+15550001111";
  const session = createCallSession(callSid, phone, "+18005551212");
  session.orderContextConfirmed = true;
  session.currentOrderData = { ...ORDER_CONTEXT };
  applyCallerVerificationFromOrder(session, {
    status: "found",
    orderNumber: "48065",
    customerName: "Frederick Marcalus",
    customerPhone: "+15551234567",
    customerId: "gid://shopify/Customer/1",
    totalOrderCount: 10,
  } as any);
  if (!verified) {
    session.isVerifiedCaller = false;
  }
  return session;
}

function filteredContext(session: CallSession) {
  return filterOrderContextForVerification(
    session.currentOrderData as any,
    session.isVerifiedCaller === true,
  );
}

describe("canRevealOrderField", () => {
  it("allows normal order fields for non-verified callers", () => {
    expect(canRevealOrderField("itemTitle", false)).toBe(true);
    expect(canRevealOrderField("itemPrice", false)).toBe(true);
    expect(canRevealOrderField("shippingFee", false)).toBe(true);
    expect(canRevealOrderField("totalAmount", false)).toBe(true);
    expect(canRevealOrderField("notificationDestinationMasked", false)).toBe(true);
  });

  it("blocks shipping and history for non-verified callers", () => {
    expect(canRevealOrderField("shippingAddress", false)).toBe(false);
    expect(canRevealOrderField("fullPreviousOrderHistory", false)).toBe(false);
    expect(canRevealOrderField("paymentCardLast4", false)).toBe(true);
    expect(canRevealOrderField("customerName", false)).toBe(true);
    expect(canRevealOrderField("fullCustomerEmail", false)).toBe(true);
  });
});

describe("non-verified order field disclosure", () => {
  it("1 — provides item title", () => {
    const session = seedSession("NF_1", false);
    const speech = buildOrderDetailSpeech(session, "what is the item title", filteredContext(session));
    expect(speech).toMatch(/Healing Book/i);
  });

  it("2 — provides item price", () => {
    const session = seedSession("NF_2", false);
    const speech = buildOrderDetailSpeech(session, "what is the item price", filteredContext(session));
    expect(speech).toMatch(/\$12\.00/i);
  });

  it("3 — provides shipping fee", () => {
    const session = seedSession("NF_3", false);
    const speech = buildOrderDetailSpeech(session, "what is the shipping fee", filteredContext(session));
    expect(speech).toMatch(/\$5\.00/i);
  });

  it("4 — provides title, price, shipping fee, and total together", () => {
    const session = seedSession("NF_4", false);
    const fields = detectRequestedOrderFields(
      "tell me item title, item price, shipping fee, and total amount",
    );
    expect(fields).toEqual(
      expect.arrayContaining(["product_title", "item_price", "shipping_fee", "total_amount"]),
    );
    const speech = buildOrderDetailSpeech(
      session,
      "tell me item title, item price, shipping fee, and total amount",
      filteredContext(session),
    );
    expect(speech).toMatch(/Healing Book/i);
    expect(speech).toMatch(/\$12\.00/i);
    expect(speech).toMatch(/\$5\.00/i);
    expect(speech).toMatch(/\$17\.00/i);
  });

  it("5 — answers confirmation email for unverified callers", () => {
    const session = seedSession("NF_5", false);
    const speech = buildOrderDetailSpeech(
      session,
      "where was the confirmation sent",
      filteredContext(session),
    );
    expect(speech).toMatch(/fred@example\.com|fred at example/i);
  });

  it("6 — refuses shipping address and offers support", () => {
    const session = seedSession("NF_6", false);
    const speech = buildOrderDetailSpeech(
      session,
      "what is the shipping address",
      filteredContext(session),
    );
    expect(speech).toMatch(/cannot provide the shipping address|can't provide the shipping address|cannot share the shipping address/i);
    expect(speech).toMatch(/support/i);
    expect(speech).not.toMatch(/123 Main St/i);
  });

  it("7 — gives previous order count only for history request", () => {
    expect(buildUnverifiedOrderHistorySpeech(10)).toMatch(/10 previous orders/i);
    expect(buildUnverifiedOrderHistorySpeech(10)).toMatch(/can't provide detailed order history/i);
  });
});

describe("verified order field disclosure", () => {
  it("8 — provides shipping address", () => {
    const session = seedSession("VF_8", true);
    const speech = buildOrderDetailSpeech(
      session,
      "what is the shipping address",
      filteredContext(session),
    );
    expect(speech).toMatch(/123 Main St/i);
  });

  it("9 — provides month-wise order history overview", () => {
    const session = seedSession("VF_9", true);
    setOrderHistoryContext(
      session,
      [
        {
          orderNumber: "#100",
          monthYear: "June 2025",
          totalAmount: "$20.00",
          status: "fulfilled",
          items: "Book A",
        },
      ],
      10,
    );
    const speech = buildVerifiedHistoryOverviewSpeech(session.orderHistoryContext!);
    expect(speech).toMatch(/10 past orders/i);
    expect(speech).toMatch(/June/i);
    const june = buildMonthDrillDownSpeech(session.orderHistoryContext!, "June");
    expect(june).toMatch(/Book A/i);
  });

  it("10 — provides title, price, shipping fee, and total", () => {
    const session = seedSession("VF_10", true);
    const speech = buildOrderDetailSpeech(
      session,
      "tell me item title, item price, shipping fee, and total amount",
      filteredContext(session),
    );
    expect(speech).toMatch(/Healing Book/i);
    expect(speech).toMatch(/\$12\.00/i);
    expect(speech).toMatch(/\$5\.00/i);
    expect(speech).toMatch(/\$17\.00/i);
  });
});
