import { describe, expect, it, vi } from "vitest";
import {
  executeLlmTool,
  buildActiveOrderContextPayload,
  buildOrderNotFoundLlmPayload,
  SYSTEM_MAINTENANCE_LLM_PAYLOAD,
  toolResultForLlm,
} from "../src/adapters/llmToolExecutor.js";
import type { LlmToolExecutionRecord } from "../src/adapters/llmToolExecutor.js";
import { ShopifyAuthError } from "../src/platform/shopifyErrors.js";

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", () => ({
  getOrderStatus: vi.fn(),
  searchByISBN: vi.fn(),
  searchByTitle: vi.fn(),
}));

import { getOrderStatus } from "../src/adapters/shopifyStorefrontAdapter.js";

describe("toolResultForLlm order shaping", () => {
  it("emits snake_case fields for order status with null placeholders", () => {
    const record: LlmToolExecutionRecord = {
      tool: "get_shopify_order_status",
      args: { orderNumber: "21698" },
      ok: true,
      status: "found",
      elapsedMs: 10,
      data: {
        status: "found",
        orderNumber: "#21698-F1",
        customerName: "Joel Moore",
        totalAmount: "96.00 USD",
        shippingFee: "5.00 USD",
        refundStatus: "REFUNDED",
        refundReason: "OUT OF STOCK",
        refundNotificationEmail: "zzyxx2002@yahoo.com",
        paymentGateway: "PayPal Express Checkout",
        lineItems: [{ title: "The Holy Bible - King James Version", quantity: 1 }],
      },
    };

    const parsed = JSON.parse(toolResultForLlm(record)) as {
      data: Record<string, unknown>;
      instructions: string;
    };

    expect(parsed.data.customer_name).toBe("Joel Moore");
    expect(parsed.data.refund_notification_email).toBe("zzyxx2002@yahoo.com");
    expect(parsed.data.payment_gateway).toBe("PayPal Express Checkout");
    expect(parsed.data.payment_method_last4).toBeNull();
    expect(parsed.data.card_brand).toBeNull();
    // Omni-Extractor payload keys must always be present (null allowed).
    for (const key of [
      "customer_name",
      "payment_method_last4",
      "card_brand",
      "refund_notification_email",
    ]) {
      expect(key in parsed.data).toBe(true);
    }
    expect(parsed.instructions).toMatch(/progressive disclosure|ORDER LOOKUP S\.O\.P/i);
    expect(parsed.instructions).toMatch(/INTERNATIONAL REFUND PROTOCOL/i);
    expect(parsed.status).toBe("FOUND");
    expect(parsed.found).toBe(true);
  });

  it("preserves payment_method_last4 and card_brand in LLM and session payloads", () => {
    const record: LlmToolExecutionRecord = {
      tool: "get_shopify_order_status",
      args: { orderNumber: "21796" },
      ok: true,
      status: "found",
      elapsedMs: 10,
      data: {
        status: "found",
        orderNumber: "#21796",
        customerName: "Jamaica Thompson",
        cardLast4: "4242",
        cardBrand: "Visa",
        refundStatus: "REFUNDED",
        refundNotificationEmail: "jamaicathompson87@gmail.com",
      },
    };

    const parsed = JSON.parse(toolResultForLlm(record)) as {
      data: Record<string, unknown>;
    };
    expect(parsed.data.customer_name).toBe("Jamaica Thompson");
    expect(parsed.data.payment_method_last4).toBe("4242");
    expect(parsed.data.card_brand).toBe("Visa");
    expect(parsed.data.refund_notification_email).toBe("jamaicathompson87@gmail.com");

    const sessionPayload = buildActiveOrderContextPayload(record.data);
    expect(sessionPayload.customer_name).toBe("Jamaica Thompson");
    expect(sessionPayload.payment_method_last4).toBe("4242");
    expect(sessionPayload.card_brand).toBe("Visa");
    expect(sessionPayload.refund_notification_email).toBe(
      "jamaicathompson87@gmail.com",
    );
  });

  it("includes tracking_number and tracking_number_for_tts in order payload", () => {
    const record: LlmToolExecutionRecord = {
      tool: "get_shopify_order_status",
      args: { orderNumber: "12345" },
      ok: true,
      status: "found",
      elapsedMs: 10,
      data: {
        status: "found",
        orderNumber: "#12345",
        trackingNumber: "1Z999999999",
        trackingCompany: "UPS",
        fulfillmentStatus: "In transit",
      },
    };

    const parsed = JSON.parse(toolResultForLlm(record)) as {
      data: Record<string, unknown>;
    };

    expect(parsed.data.tracking_number).toBe("1Z999999999");
    expect(parsed.data.tracking_company).toBe("UPS");
    expect(String(parsed.data.tracking_number_for_tts)).toContain('<break time="800ms"/>');
  });

  it("returns strict NOT_FOUND payload with searched_number for hallucination lock", () => {
    const record: LlmToolExecutionRecord = {
      tool: "get_shopify_order_status",
      args: { orderNumber: "#21698" },
      ok: false,
      status: "not_found",
      elapsedMs: 8,
      data: {
        status: "not_found",
        searchedNumber: "#21698",
        error: "No exact match found in Shopify.",
      },
    };

    const parsed = JSON.parse(toolResultForLlm(record)) as Record<string, unknown>;

    expect(parsed).toEqual(buildOrderNotFoundLlmPayload("#21698"));
    expect(parsed.status).toBe("NOT_FOUND");
    expect(parsed.searched_number).toBe("21698");
    expect(parsed.error).toBe("No exact match found in Shopify.");
    expect(parsed).not.toHaveProperty("data");
    expect(parsed).not.toHaveProperty("customer_name");
    expect(parsed).not.toHaveProperty("items");
    expect(parsed).not.toHaveProperty("found");
  });

  it("returns sanitized SYSTEM_MAINTENANCE payload for auth failures", () => {
    const record: LlmToolExecutionRecord = {
      tool: "get_shopify_order_status",
      args: { orderNumber: "12345" },
      ok: false,
      status: "system_maintenance",
      elapsedMs: 5,
      data: {
        status: "system_maintenance",
        message: "Catalog temporarily unavailable",
      },
    };

    const parsed = JSON.parse(toolResultForLlm(record)) as typeof SYSTEM_MAINTENANCE_LLM_PAYLOAD;
    expect(parsed).toEqual(SYSTEM_MAINTENANCE_LLM_PAYLOAD);
    expect(parsed.error).toBe("SYSTEM_MAINTENANCE");
  });
});

describe("executeLlmTool error boundary", () => {
  it("maps Shopify 401 auth failures to SYSTEM_MAINTENANCE for the LLM", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "system_maintenance",
      message: "Catalog temporarily unavailable",
    });

    const record = await executeLlmTool(
      "get_shopify_order_status",
      { orderNumber: "12345" },
      "CA_AUTH",
    );

    expect(record.status).toBe("system_maintenance");
    const parsed = JSON.parse(toolResultForLlm(record)) as { error: string };
    expect(parsed.error).toBe("SYSTEM_MAINTENANCE");
  });

  it("never passes raw ShopifyAuthError text to the LLM", async () => {
    vi.mocked(getOrderStatus).mockRejectedValue(new ShopifyAuthError(401));

    const record = await executeLlmTool(
      "get_shopify_order_status",
      { orderNumber: "12345" },
      "CA_AUTH",
    );

    expect(record.status).toBe("system_maintenance");
    const payload = toolResultForLlm(record);
    expect(payload).not.toMatch(/401|unauthorized|invalid token/i);
    expect(JSON.parse(payload)).toEqual(SYSTEM_MAINTENANCE_LLM_PAYLOAD);
  });

  it("normalizes spoken order numbers before Shopify lookup", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "not_found",
      searchedNumber: "#21698",
      error: "No exact match found in Shopify.",
    });

    await executeLlmTool(
      "get_shopify_order_status",
      { orderNumber: "two one six nine eight" },
      "CA_NORM",
    );

    expect(getOrderStatus).toHaveBeenCalledWith("#21698", "CA_NORM");
  });
});
