import { describe, expect, it, vi, beforeEach } from "vitest";
import { runLlmAgentTurnEvents } from "../src/adapters/openaiAdapter.js";
import { ORDER_NOT_FOUND_STRICT_SPOKEN } from "../src/constants/systemMessages.js";

vi.mock("../src/adapters/llmToolExecutor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/llmToolExecutor.js")>();
  return {
    ...actual,
    executeLlmTool: vi.fn(),
  };
});

import { executeLlmTool } from "../src/adapters/llmToolExecutor.js";

describe("runLlmAgentTurnEvents grounded order speech", () => {
  beforeEach(() => {
    vi.mocked(executeLlmTool).mockReset();
  });

  it("forces Shopify lookup and speaks only deterministic order TTS", async () => {
    vi.mocked(executeLlmTool).mockResolvedValue({
      tool: "get_shopify_order_status",
      args: { orderNumber: "#21698-F1" },
      ok: true,
      status: "found",
      elapsedMs: 12,
      data: {
        status: "found",
        orderNumber: "#21698-F1",
        customerName: "Joel Moore",
        lineItems: [{ title: "The Holy Bible - King James Version", quantity: 1 }],
        totalAmount: "96.00 USD",
        shippingFee: "5.00 USD",
        paymentGateway: "PayPal Express Checkout",
        refundStatus: "REFUNDED",
        refundReason: "OUT OF STOCK",
        refundNotificationEmail: "zzyxx2002@yahoo.com",
      },
    });

    let speech = "";
    for await (const event of runLlmAgentTurnEvents({
      callSid: "CA_GROUND",
      userMessage: "My order number is 21698",
      messages: [{ role: "user", content: "My order number is 21698" }],
    })) {
      if (event.type === "result") speech = event.result.speech;
    }

    expect(executeLlmTool).toHaveBeenCalledWith(
      "get_shopify_order_status",
      expect.objectContaining({ orderNumber: expect.any(String) }),
      "CA_GROUND",
    );
    expect(speech).toContain("Joel Moore");
    expect(speech).toContain("zzyxx2002@yahoo.com");
    expect(speech).not.toMatch(/\bfake\b/i);
  });

  it("uses strict NOT_FOUND spoken message without LLM paraphrase", async () => {
    vi.mocked(executeLlmTool).mockResolvedValue({
      tool: "get_shopify_order_status",
      args: { orderNumber: "#21698" },
      ok: false,
      status: "not_found",
      elapsedMs: 8,
      data: {
        status: "not_found",
        error: "Order not found in database.",
      },
    });

    let speech = "";
    for await (const event of runLlmAgentTurnEvents({
      callSid: "CA_NOTFOUND",
      userMessage: "21698",
      messages: [
        { role: "assistant", content: "Sure — what's your order number?" },
        { role: "user", content: "21698" },
      ],
    })) {
      if (event.type === "result") speech = event.result.speech;
    }

    expect(speech).toBe(ORDER_NOT_FOUND_STRICT_SPOKEN);
    expect(speech).not.toMatch(/Joel|Moore|dollars|yahoo|gmail/i);
  });
});
