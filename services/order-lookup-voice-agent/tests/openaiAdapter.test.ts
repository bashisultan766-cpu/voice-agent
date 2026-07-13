import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  runLlmAgentTurnEvents,
  syncDeterministicAssistantSpeech,
} from "../src/adapters/openaiAdapter.js";
import { ORDER_NOT_FOUND_STRICT_SPOKEN } from "../src/constants/systemMessages.js";
import { clearAllAgentStates, getAgentState } from "../src/platform/stateProjection.js";
import { markCallSessionActive, clearAllCallSessionLocks } from "../src/voice/callSessionLock.js";

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
    clearAllAgentStates();
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
        customerEmail: "joel.moore@gmail.com",
        itemCount: 1,
        lineItems: [{ title: "The Holy Bible - King James Version", quantity: 1 }],
        totalAmount: "96.00 USD",
        orderPlacedAt: "2025-04-01T10:00:00Z",
        subtotalAmount: "91.00 USD",
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
      undefined,
      expect.objectContaining({ skipPolicy: true }),
    );
    expect(speech).toBe("I've found your order. How can I help you with this one?");
    expect(speech).not.toContain("Joel Moore");
    expect(speech).not.toContain("OUT OF STOCK");
    expect(speech).not.toMatch(/The books cost/i);
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

  it("forces lookup for bare digits after greeting without asking for order number again", async () => {
    vi.mocked(executeLlmTool).mockResolvedValue({
      tool: "get_shopify_order_status",
      args: { orderNumber: "#21698" },
      ok: true,
      status: "found",
      elapsedMs: 10,
      data: {
        status: "found",
        orderNumber: "#21698",
        itemCount: 1,
        lineItems: [{ title: "Test Book", quantity: 1 }],
        totalAmount: "10.00 USD",
        orderPlacedAt: "2025-04-01T10:00:00Z",
        refundStatus: "NONE",
      },
    });

    const session = {
      callSid: "CA_BARE",
      from: "+1",
      to: "+2",
      phase: "follow_up" as const,
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      greetedThisCall: true,
    };

    let forced = false;
    for await (const event of runLlmAgentTurnEvents({
      callSid: "CA_BARE",
      userMessage: "21698",
      messages: [
        { role: "assistant", content: "I'm doing well, thanks for asking. What can I help you with today?" },
        { role: "user", content: "21698" },
      ],
      session,
    })) {
      if (event.type === "tool_pending") forced = true;
    }

    expect(forced).toBe(true);
    expect(executeLlmTool).toHaveBeenCalled();
  });

  it("asks for digits when caller says they have an order number", async () => {
    let speech = "";
    const session = {
      callSid: "CA_OFFER",
      from: "+1",
      to: "+2",
      phase: "follow_up" as const,
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      greetedThisCall: true,
      awaitingInput: null as null,
    };

    for await (const event of runLlmAgentTurnEvents({
      callSid: "CA_OFFER",
      userMessage: "I have an order number",
      messages: [{ role: "user", content: "I have an order number" }],
      session,
    })) {
      if (event.type === "result") speech = event.result.speech;
    }

    expect(speech).toMatch(/tell me your order number/i);
    expect(session.awaitingInput).toBe("order_number");
    expect(executeLlmTool).not.toHaveBeenCalled();
  });
});

describe("syncDeterministicAssistantSpeech", () => {
  beforeEach(() => {
    clearAllAgentStates();
    clearAllCallSessionLocks();
    markCallSessionActive("CA_SYNC");
  });

  afterEach(() => {
    clearAllCallSessionLocks();
  });

  it("appends assistant speech to LLM message history for next-turn context", () => {
    syncDeterministicAssistantSpeech("CA_SYNC", "I found the order for Joel Moore.", {
      responseType: "order_found",
      recordOrderNumber: "#21698-F1",
      finalizeToolExecution: true,
    });

    const state = getAgentState("CA_SYNC");
    const assistant = state.messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toContain("Joel Moore");
  });
});
