import { describe, expect, it, vi } from "vitest";
import type { CallSession } from "../src/types/order.js";
import { executeLlmTool } from "../src/adapters/llmToolExecutor.js";

const { mockCreateShopifyDraftOrder, mockSendCheckoutEmail } = vi.hoisted(() => ({
  mockCreateShopifyDraftOrder: vi.fn(),
  mockSendCheckoutEmail: vi.fn(),
}));

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", () => ({
  createShopifyDraftOrder: mockCreateShopifyDraftOrder,
  getOrderStatus: vi.fn(),
  searchByISBN: vi.fn(),
  searchByTitle: vi.fn(),
}));

vi.mock("../src/utils/resendEmailService.js", () => ({
  isResendAvailable: vi.fn(() => true),
  // Simple RFC-ish validation for unit tests.
  isValidCustomerEmail: vi.fn((email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
  sendCheckoutEmail: mockSendCheckoutEmail,
  sendSupportEscalation: vi.fn(),
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
    expect(record.status).toBe("blocked");
    expect(record.errorMessage).toMatch(/Valid customer email/i);
    expect(mockCreateShopifyDraftOrder).not.toHaveBeenCalled();
    expect(mockSendCheckoutEmail).not.toHaveBeenCalled();
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
    expect(mockCreateShopifyDraftOrder).not.toHaveBeenCalled();
  });

  it("creates draft + sends checkout email on success", async () => {
    vi.mocked(mockCreateShopifyDraftOrder).mockResolvedValue({
      success: true,
      status: "found",
      invoiceUrl: "https://checkout.example/invoice/abc",
      draftOrderName: "#DO-123",
    });
    vi.mocked(mockSendCheckoutEmail).mockResolvedValue({
      ok: true,
      messageId: "msg_1",
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
    expect(session.pendingDraftOrderName).toBe("#DO-123");
    expect(mockCreateShopifyDraftOrder).toHaveBeenCalledTimes(1);
    expect(mockSendCheckoutEmail).toHaveBeenCalledTimes(1);
  });
});

