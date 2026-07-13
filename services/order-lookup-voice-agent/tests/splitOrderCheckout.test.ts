import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CallSession } from "../src/types/order.js";
import {
  resolveCheckoutLineItems,
  deductCheckedOutItems,
  ensureShoppingCart,
} from "../src/agents/cartManager.js";
import { sendCheckoutPaymentLink } from "../src/services/checkoutEmailService.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../src/prompts/systemPrompt.js";

const { mockCreateDraft, mockSendEmail, mockResendAvailable } = vi.hoisted(() => ({
  mockCreateDraft: vi.fn(),
  mockSendEmail: vi.fn(),
  mockResendAvailable: vi.fn(() => true),
}));

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", () => ({
  createShopifyDraftOrder: mockCreateDraft,
}));

vi.mock("../src/utils/resendEmailService.js", () => ({
  isResendAvailable: mockResendAvailable,
  isValidCustomerEmail: (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  sendCheckoutEmail: mockSendEmail,
}));

function sessionWithCart(callSid: string): CallSession {
  return {
    callSid,
    from: "+1",
    to: "+2",
    phase: "cart_active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    shoppingCart: [
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Book A",
        quantity: 2,
        unitPrice: "10.00",
        price: "10.00",
      },
      {
        variantId: "gid://shopify/ProductVariant/2",
        productId: "gid://shopify/Product/2",
        title: "Book B",
        quantity: 2,
        unitPrice: "12.00",
        price: "12.00",
      },
      {
        variantId: "gid://shopify/ProductVariant/3",
        productId: "gid://shopify/Product/3",
        title: "Book C",
        quantity: 2,
        unitPrice: "8.00",
        price: "8.00",
      },
    ],
  } as CallSession;
}

describe("split-order checkout", () => {
  beforeEach(() => {
    mockCreateDraft.mockReset();
    mockSendEmail.mockReset();
    mockResendAvailable.mockReturnValue(true);
    mockCreateDraft.mockResolvedValue({
      success: true,
      invoiceUrl: "https://checkout.example/inv",
      draftOrderName: "#D1",
    });
    mockSendEmail.mockResolvedValue({ ok: true });
  });

  it("system prompt includes THE SPLIT-ORDER CHECKOUT PROTOCOL", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/THE SPLIT-ORDER CHECKOUT PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /Let's do this one step at a time so nothing gets mixed up/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER collect all emails at the same time/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/one batch, one email, one link/i);
  });

  it("resolves a subset of cart lines without touching the rest", () => {
    const session = sessionWithCart("CA_SPLIT_RESOLVE");
    const resolved = resolveCheckoutLineItems(session, [
      { title: "Book A", quantity: 2 },
      { variant_id: "gid://shopify/ProductVariant/2", quantity: 1 },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.isSubset).toBe(true);
    expect(resolved.items).toHaveLength(2);
    expect(resolved.items[0]?.title).toBe("Book A");
    expect(resolved.items[0]?.quantity).toBe(2);
    expect(resolved.items[1]?.quantity).toBe(1);
    expect(ensureShoppingCart(session)).toHaveLength(3);
  });

  it("deducts only checked-out quantities from the cart", () => {
    const session = sessionWithCart("CA_SPLIT_DEDCT");
    deductCheckedOutItems(session, [
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Book A",
        quantity: 2,
      },
    ]);
    const cart = ensureShoppingCart(session);
    expect(cart.find((line) => line.title === "Book A")).toBeUndefined();
    expect(cart).toHaveLength(2);
  });

  it("sends a split batch then leaves remaining books for the next email", async () => {
    const session = sessionWithCart("CA_SPLIT_SEND");
    session.emailConfirmation = {
      workflowType: "payment_link",
      phase: "confirmed",
      confirmationStatus: "confirmed",
      sentStatus: "pending",
      confirmedEmail: "a@example.com",
      normalizedEmail: "a@example.com",
    } as CallSession["emailConfirmation"];

    const first = await sendCheckoutPaymentLink(session, "a@example.com", {
      customerName: "Caller",
      items: [{ title: "Book A", quantity: 2 }],
    });

    expect(first.ok).toBe(true);
    expect(first.splitBatch).toBe(true);
    expect(first.remainingCartUnits).toBe(4);
    expect(session.shoppingCart?.some((line) => line.title === "Book A")).toBe(false);
    expect(session.paymentLinkSent).not.toBe(true);
    expect(session.emailConfirmation?.phase).toBe("idle");

    const second = await sendCheckoutPaymentLink(session, "b@example.com", {
      customerName: "Caller",
      items: [{ title: "Book B", quantity: 2 }],
    });
    expect(second.ok).toBe(true);
    expect(second.remainingCartUnits).toBe(2);

    const third = await sendCheckoutPaymentLink(session, "c@example.com", {
      customerName: "Caller",
      items: [{ title: "Book C", quantity: 2 }],
    });
    expect(third.ok).toBe(true);
    expect(third.remainingCartUnits).toBe(0);
    expect(session.paymentLinkSent).toBe(true);
    expect(mockCreateDraft).toHaveBeenCalledTimes(3);
  });
});
