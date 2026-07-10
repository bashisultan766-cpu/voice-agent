import { describe, expect, it, vi } from "vitest";
import type { CallSession } from "../src/types/order.js";
import { executeLlmTool } from "../src/adapters/llmToolExecutor.js";

const { mockSendCheckoutPaymentLink } = vi.hoisted(() => ({
  mockSendCheckoutPaymentLink: vi.fn(),
}));

vi.mock("../src/services/checkoutEmailService.js", () => ({
  sendCheckoutPaymentLink: mockSendCheckoutPaymentLink,
  PAYMENT_LINK_SUCCESS_SPEECH:
    "Your payment link has been sent successfully. Please check your inbox.",
}));

describe("send_checkout_email tool execution", () => {
  it("blocks on invalid customer email", async () => {
    const session = {
      callSid: "CA_CHEM1",
      from: "+1",
      to: "+2",
      phase: "cart_active",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      shoppingCart: [
        {
          variantId: "gid://shopify/ProductVariant/401",
          productId: "gid://shopify/Product/123",
          title: "Test Book",
          quantity: 1,
          unitPrice: "10.00",
          price: "10.00",
        },
      ],
    } as unknown as CallSession;

    const record = await executeLlmTool(
      "send_checkout_email",
      { customerEmail: "not-an-email", customerName: "Jane Doe" },
      "CA_CHEM1",
      session,
    );

    expect(record.ok).toBe(false);
    expect(record.status).toBe("invalid_format");
    expect(record.errorMessage).toMatch(/Validation Error:.*customerEmail|Valid customer email/i);
    expect(mockSendCheckoutPaymentLink).not.toHaveBeenCalled();
  });

  it("blocks on empty cart", async () => {
    const session = {
      callSid: "CA_CHEM2",
      from: "+1",
      to: "+2",
      phase: "cart_active",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      shoppingCart: [],
    } as unknown as CallSession;

    const record = await executeLlmTool(
      "send_checkout_email",
      { customerEmail: "jane@example.com", customerName: "Jane Doe" },
      "CA_CHEM2",
      session,
    );

    expect(record.ok).toBe(false);
    expect(record.status).toBe("empty");
    expect(record.errorMessage).toMatch(/Cart is empty/i);
    expect(mockSendCheckoutPaymentLink).not.toHaveBeenCalled();
  });

  it("creates draft + sends checkout email on success", async () => {
    vi.mocked(mockSendCheckoutPaymentLink).mockImplementation(async (session) => {
      session.pendingInvoiceUrl = "https://checkout.example/invoice/abc";
      session.paymentLinkSent = true;
      session.paymentLinkSentTo = "jane@example.com";
      return {
        ok: true,
        message: "Your payment link has been sent successfully. Please check your inbox.",
        invoiceUrl: "https://checkout.example/invoice/abc",
      };
    });

    const session = {
      callSid: "CA_CHEM3",
      from: "+1",
      to: "+2",
      phase: "cart_active",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      shoppingCart: [
        {
          variantId: "gid://shopify/ProductVariant/401",
          productId: "gid://shopify/Product/123",
          title: "Test Book",
          quantity: 2,
          unitPrice: "10.00",
          price: "10.00",
        },
      ],
    } as unknown as CallSession;

    const record = await executeLlmTool(
      "send_checkout_email",
      { customerEmail: "jane@example.com", customerName: "Jane Doe" },
      "CA_CHEM3",
      session,
    );

    expect(record.ok).toBe(true);
    expect(record.status).toBe("sent");
    expect(session.pendingInvoiceUrl).toBe("https://checkout.example/invoice/abc");
    expect(mockSendCheckoutPaymentLink).toHaveBeenCalledTimes(1);
  });
});

