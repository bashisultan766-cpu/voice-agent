import { describe, expect, it } from "vitest";
import {
  extractRefundNotificationEmail,
  extractRefundEmail,
  extractOrderConfirmationEmail,
  extractConfirmationEmail,
  extractRefundReason,
  extractPaymentMethod,
  extractCardFromReceipt,
  extractCardFromPaymentDetails,
  extractTrackingInfo,
  formatGatewayLabel,
} from "../src/adapters/orderFieldExtractors.js";
import {
  ORDER_21698_F1_EXPECTED,
  ORDER_21698_F1_GQL_NODE,
} from "./fixtures/order21698F1.js";

describe("orderFieldExtractors", () => {
  it("aggressively extracts refund email from combined refund + notification timeline copy", () => {
    const message =
      "Darren Herrington refunded $61.42 USD. A refund notification email was sent to Jamaica Thompson (jamaicathompson87@gmail.com)";
    expect(extractRefundNotificationEmail([{ message }], [])).toBe(
      "jamaicathompson87@gmail.com",
    );
    expect(extractRefundEmail([{ message }], [])).toBe("jamaicathompson87@gmail.com");
  });

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

  it("aggressively extracts confirmation email from confirm/placed + email", () => {
    expect(
      extractOrderConfirmationEmail([
        {
          message:
            "Order confirmation email was sent to Jamaica Thompson (jamaicathompson87@gmail.com).",
        },
      ]),
    ).toBe("jamaicathompson87@gmail.com");
    expect(
      extractConfirmationEmail([
        { message: "Order placed — receipt emailed to buyer@example.com" },
      ]),
    ).toBe("buyer@example.com");
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
      ORDER_21698_F1_GQL_NODE.transactions.edges.map((e) => e.node),
      ORDER_21698_F1_GQL_NODE.paymentGatewayNames,
    );
    expect(payment.cardLast4).toBeUndefined();
    expect(payment.paymentGateway).toBe("PayPal Express Checkout");
  });

  it("maps payment_method_last4 and card_brand from paymentDetails number/company", () => {
    const payment = extractPaymentMethod(
      [
        {
          kind: "SALE",
          status: "SUCCESS",
          gateway: "shopify_payments",
          paymentDetails: { company: "Visa", number: "•••• 4242" },
        },
      ],
      ["Shopify Payments"],
    );
    expect(payment.cardLast4).toBe("4242");
    expect(payment.cardBrand).toBe("Visa");
  });

  it("maps last4/brand aliases and receiptJson when number/company are absent", () => {
    expect(
      extractCardFromPaymentDetails({ last4: "1234", brand: "Mastercard" }),
    ).toEqual({ cardLast4: "1234", cardBrand: "Mastercard" });

    expect(
      extractCardFromReceipt(
        JSON.stringify({
          payment_method_details: { card: { last4: "9876", brand: "Visa" } },
        }),
      ),
    ).toEqual({ cardLast4: "9876", cardBrand: "Visa" });

    const payment = extractPaymentMethod(
      [
        {
          kind: "SALE",
          status: "SUCCESS",
          gateway: "shopify_payments",
          paymentDetails: {},
          receiptJson: JSON.stringify({
            payment_method_details: { card: { last4: "5555", brand: "Amex" } },
          }),
        },
      ],
      ["Shopify Payments"],
    );
    expect(payment.cardLast4).toBe("5555");
    expect(payment.cardBrand).toBe("Amex");
  });

  it("falls back to refund transaction paymentDetails for card digits", () => {
    const payment = extractPaymentMethod(
      [{ kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", paymentDetails: {} }],
      ["Shopify Payments"],
      [
        {
          transactions: [
            { paymentDetails: { company: "Visa", number: "1111" } },
          ],
        },
      ],
    );
    expect(payment.cardLast4).toBe("1111");
    expect(payment.cardBrand).toBe("Visa");
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
