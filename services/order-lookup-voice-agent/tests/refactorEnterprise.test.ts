import { describe, expect, it } from "vitest";
import { formatProductResults } from "../src/agents/productResponseFormatter.js";
import {
  extractNotificationDeliveryFromMessages,
  formatNotificationDeliverySpeech,
} from "../src/adapters/orderFieldExtractors.js";
import { buildProgressiveDisclosureOrderSpeech } from "../src/utils/orderDataParser.js";
import { normalizeSpokenNumericSequence } from "../src/nlp/entityExtractor.js";
import { executeLlmTool } from "../src/adapters/llmToolExecutor.js";
import type { CallSession } from "../src/types/order.js";
import { vi } from "vitest";

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
  isValidCustomerEmail: vi.fn((email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
  sendCheckoutEmail: mockSendCheckoutEmail,
  sendSupportEscalation: vi.fn(),
}));

describe("semantic product search disclosure", () => {
  it("uses similar-matches prefix when exact title is missing", () => {
    const speech = formatProductResults(
      [
        {
          id: "1",
          title: "Rich Dad Poor Dad",
          variants: [{ price: "12.00", inStock: true }],
        },
        {
          id: "2",
          title: "Rich Dad's Guide",
          variants: [{ price: "10.00", inStock: true }],
        },
      ] as any,
      true,
    );
    expect(speech).toMatch(/couldn't find the exact title/i);
    expect(speech).toContain("Rich Dad Poor Dad");
    expect(speech).toContain("Rich Dad's Guide");
  });
});

describe("concise order lookup disclosure", () => {
  it("returns status and date only template", () => {
    const speech = buildProgressiveDisclosureOrderSpeech({
      orderNumber: "#21698",
      isRefunded: false,
      fulfillmentStatus: "fulfilled",
      orderPlacedAtSpoken: "March 10th, 2025",
    } as any);
    expect(speech).toBe("Your order 21698 is fulfilled as of March 10th, 2025.");
    expect(speech).not.toContain("shipping");
    expect(speech).not.toContain("total");
  });
});

describe("multi-channel notification parsing", () => {
  it("detects SMS delivery from timeline", () => {
    const delivery = extractNotificationDeliveryFromMessages([
      "SMS notification was sent to +1 (555) 123-4567",
    ]);
    expect(delivery?.channel).toBe("sms");
    expect(formatNotificationDeliverySpeech(delivery!)).toBe(
      "The notification was sent to +1 (555) 123-4567.",
    );
  });

  it("detects email delivery from timeline", () => {
    const delivery = extractNotificationDeliveryFromMessages([
      "sent a refund notification email to jane@example.com on June 2",
    ]);
    expect(delivery?.channel).toBe("email");
    expect(formatNotificationDeliverySpeech(delivery!)).toBe(
      "The notification was sent to jane@example.com.",
    );
  });
});

describe("spoken ID parsing", () => {
  it("reads twenty as 20 not 2.0", () => {
    expect(normalizeSpokenNumericSequence("twenty")).toBe("20");
    expect(normalizeSpokenNumericSequence("twenty one six nine eight")).toBe("21698");
  });
});

describe("confirm-once payment link", () => {
  it("does not resend checkout email when already sent this call", async () => {
    const session = {
      callSid: "CA_CONFIRM_ONCE",
      from: "+1",
      to: "+2",
      phase: "cart_active",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      paymentLinkSent: true,
      paymentLinkSentTo: "jane@example.com",
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
      { customerEmail: "jane@example.com", customerName: "Jane" },
      "CA_CONFIRM_ONCE",
      session,
    );

    expect(record.ok).toBe(true);
    expect(record.data).toMatchObject({
      status: "sent",
      message: expect.stringMatching(/already sent/i),
    });
    expect(mockCreateShopifyDraftOrder).not.toHaveBeenCalled();
    expect(mockSendCheckoutEmail).not.toHaveBeenCalled();
  });
});
