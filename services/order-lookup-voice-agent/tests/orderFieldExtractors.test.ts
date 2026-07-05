import { describe, expect, it } from "vitest";
import {
  extractRefundNotificationEmail,
  extractRefundReason,
  extractPaymentMethod,
  extractTrackingInfo,
  formatGatewayLabel,
} from "../src/adapters/orderFieldExtractors.js";
import {
  ORDER_21698_F1_EXPECTED,
  ORDER_21698_F1_GQL_NODE,
} from "./fixtures/order21698F1.js";

describe("orderFieldExtractors", () => {
  it("extracts refund notification email from timeline — not billing email", () => {
    const events = ORDER_21698_F1_GQL_NODE.events.edges.map((e) => e.node);
    const email = extractRefundNotificationEmail(events, ORDER_21698_F1_GQL_NODE.customAttributes);
    expect(email).toBe("zzyxx2002@yahoo.com");
    expect(email).not.toBe("joel.moore@gmail.com");
  });

  it("returns undefined when timeline has no refund notification email", () => {
    expect(
      extractRefundNotificationEmail(
        [{ message: "Order was placed.", action: "placed" }],
        [],
      ),
    ).toBeUndefined();
  });

  it("extracts OUT OF STOCK refund reason from custom attributes when no timeline Reason line", () => {
    const reason = extractRefundReason(
      true,
      ORDER_21698_F1_GQL_NODE.refunds,
      ORDER_21698_F1_GQL_NODE.customAttributes,
      ORDER_21698_F1_GQL_NODE.events.edges.map((e) => e.node),
    );
    expect(reason).toBe("OUT OF STOCK");
  });

  it("maps PayPal Express Checkout gateway when no card last4", () => {
    const payment = extractPaymentMethod(
      ORDER_21698_F1_GQL_NODE.transactions,
      ORDER_21698_F1_GQL_NODE.paymentGatewayNames,
    );
    expect(payment.cardLast4).toBeUndefined();
    expect(payment.paymentGateway).toBe("PayPal Express Checkout");
  });

  it("formats paypal gateway slug to human label", () => {
    expect(formatGatewayLabel("paypal")).toBe("PayPal Express Checkout");
  });

  it("extracts tracking number and carrier from fulfillments", () => {
    const tracking = extractTrackingInfo([
      {
        trackingInfo: [{ company: "USPS", number: "940011189922", url: "https://track.example" }],
      },
    ]);
    expect(tracking.trackingNumber).toBe("940011189922");
    expect(tracking.trackingCompany).toBe("USPS");
    expect(tracking.trackingUrl).toBe("https://track.example");
  });
});

describe("order #21698-F1 fixture expectations", () => {
  it("documents the real-world field contract", () => {
    expect(ORDER_21698_F1_EXPECTED.refundNotificationEmail).toBe("zzyxx2002@yahoo.com");
    expect(ORDER_21698_F1_EXPECTED.paymentGateway).toBe("PayPal Express Checkout");
    expect(ORDER_21698_F1_EXPECTED.refundReason).toBe("OUT OF STOCK");
  });
});
