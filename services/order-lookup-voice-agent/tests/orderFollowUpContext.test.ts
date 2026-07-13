import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createCallSession } from "../src/agents/conversationOrchestrator.js";
import { runLlmOrchestratorTurn } from "../src/agents/llmOrchestrator.js";
import {
  buildLlmTurnMessagesForTest,
  syncDeterministicAssistantSpeech,
} from "../src/adapters/openaiAdapter.js";
import { clearAllAgentStates, getAgentState } from "../src/platform/stateProjection.js";
import { markCallSessionActive, clearAllCallSessionLocks } from "../src/voice/callSessionLock.js";
import type { CallSession } from "../src/types/order.js";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  },
}));

vi.mock("../src/adapters/llmToolExecutor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/llmToolExecutor.js")>();
  return {
    ...actual,
    executeLlmTool: vi.fn(),
  };
});

import { executeLlmTool } from "../src/adapters/llmToolExecutor.js";

async function collectOrchestratorSpeech(
  session: ReturnType<typeof createCallSession>,
  text: string,
): Promise<string> {
  let speech = "";
  for await (const event of runLlmOrchestratorTurn(session, text, () => {})) {
    if (event.type === "chunk" && typeof event.chunk.text === "string") {
      speech += event.chunk.text;
    }
  }
  return speech;
}

describe("multi-turn order follow-up context injection", () => {
  beforeEach(() => {
    vi.mocked(executeLlmTool).mockReset();
    mockCreate.mockReset();
    clearAllAgentStates();
    clearAllCallSessionLocks();
    markCallSessionActive("CA_MULTI");
  });

  afterEach(() => {
    clearAllCallSessionLocks();
  });

  it("Turn 1 lookup saves context; Turn 2 injects JSON for refund email follow-up", async () => {
    vi.mocked(executeLlmTool).mockResolvedValue({
      tool: "get_shopify_order_status",
      args: { orderNumber: "#21698" },
      ok: true,
      status: "found",
      elapsedMs: 10,
      data: {
        status: "found",
        orderNumber: "#21698-F1",
        customerName: "Joel Moore",
        customerPhone: "+15551234567",
        refundStatus: "REFUNDED",
        refundReason: "OUT OF STOCK",
        refundNotificationEmail: "btazp@yahoo.com",
        fulfillmentStatus: "unfulfilled",
      },
    });

    const session = createCallSession("CA_MULTI", "+15551234567", "+2");

    const turn1Speech = await collectOrchestratorSpeech(session, "Order 21698");

    expect(turn1Speech).toMatch(/I found your order 21698-F1\./);
    expect(turn1Speech).toMatch(/currently Refunded/);
    expect(turn1Speech).toContain("btazp@yahoo.com");
    expect(session.isVerifiedCaller).toBe(true);
    expect(session.currentOrderData?.refund_notification_email).toBe("btazp@yahoo.com");
    expect(session.phase).toBe("order_disclosed");

    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: "SHOULD NOT BE CALLED",
          },
          finish_reason: "stop",
        },
      ],
    });

    session.phase = "order_disclosed";
    const turn2Speech = await collectOrchestratorSpeech(
      session,
      "What was the refund email?",
    );

    expect(executeLlmTool).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(turn2Speech.toLowerCase()).toMatch(/btazp.*yahoo/);
    expect(turn2Speech).toMatch(/inbox and spam folder/i);
    expect(session.currentOrderData?.refund_notification_email).toBe("btazp@yahoo.com");
  });

  it("buildLlmTurnMessagesForTest injects active order context as hidden system message", () => {
    const messages = buildLlmTurnMessagesForTest({
      callSid: "CA_MSG",
      userMessage: "What was the refund email?",
      session: {
        callSid: "CA_MSG",
        orderContextConfirmed: true,
        isVerifiedCaller: true,
        currentOrderData: {
          order_number: "#21698-F1",
          refund_notification_email: "btazp@yahoo.com",
        },
      } as CallSession,
      messages: [
        { role: "assistant", content: "I found your order. Your order status is Refunded." },
        { role: "user", content: "What was the refund email?" },
      ],
      activeOrderContext: {
        order_number: "#21698-F1",
        refund_notification_email: "btazp@yahoo.com",
      },
    });

    expect(messages[0]?.role).toBe("system");
    const injected = messages.find(
      (m) => m.role === "system" && m.content.startsWith("ACTIVE ORDER CONTEXT:"),
    );
    expect(injected?.content).toContain("btazp@yahoo.com");
  });

  it("clears stale context after a failed order lookup", async () => {
    markCallSessionActive("CA_FAIL");
    const session = createCallSession("CA_FAIL", "+1", "+2");
    session.currentOrderData = {
      order_number: "#21698-F1",
      refund_notification_email: "btazp@yahoo.com",
    };

    vi.mocked(executeLlmTool).mockResolvedValue({
      tool: "get_shopify_order_status",
      args: { orderNumber: "#99999" },
      ok: false,
      status: "not_found",
      elapsedMs: 5,
      data: {
        status: "not_found",
        error: "No exact match found in Shopify.",
      },
    });

    syncDeterministicAssistantSpeech("CA_FAIL", "What's your order number?", {
      responseType: "clarification_question",
    });

    await collectOrchestratorSpeech(session, "99999");

    expect(executeLlmTool).toHaveBeenCalledTimes(1);
    expect(session.currentOrderData).toBeUndefined();
  });
});

describe("syncDeterministicAssistantSpeech with agent state", () => {
  beforeEach(() => {
    clearAllAgentStates();
    clearAllCallSessionLocks();
    markCallSessionActive("CA_SYNC2");
  });

  it("keeps initial order speech in history without full JSON", () => {
    syncDeterministicAssistantSpeech(
      "CA_SYNC2",
      "I found your order. Your order status is Refunded. Do you need any more information about your order?",
      {
        responseType: "order_found",
        recordOrderNumber: "#21698-F1",
        finalizeToolExecution: true,
      },
    );

    const state = getAgentState("CA_SYNC2");
    expect(state.messages.some((m) => m.content.includes("Refunded"))).toBe(true);
    expect(state.messages.some((m) => m.content.includes("btazp@yahoo.com"))).toBe(false);
  });
});
