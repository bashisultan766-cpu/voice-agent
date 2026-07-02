import { beforeEach, describe, expect, it } from "vitest";
import { classifyCallerIntent } from "../src/agents/intentClassifier.js";
import { softFallback } from "../src/agents/conversationBrainAgent.js";
import { createCallSession, handleAgentTurn } from "../src/agents/orderAgent.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";

describe("intentClassifier", () => {
  it('classifies "how are you" as greeting', async () => {
    const result = await classifyCallerIntent("how are you");
    expect(result.intent).toBe("greeting");
  });

  it('classifies "Harry Potter book" as product_search', async () => {
    const result = await classifyCallerIntent("I want Harry Potter book");
    expect(result.intent).toBe("product_search");
  });

  it('classifies ISBN speech as isbn_query', async () => {
    const result = await classifyCallerIntent("ISBN 9781234567890");
    expect(result.intent).toBe("isbn_query");
  });
});

describe("conversation brain conversations", () => {
  beforeEach(() => {
    clearAllCallMemories();
  });

  it('responds warmly to "how are you" without invalid-order error', async () => {
    const session = createCallSession("CA_GREET", "+15550001", "+15550002");
    session.phase = "awaiting_order_number";
    const result = await handleAgentTurn(session, "how are you");
    expect(result.speech).toMatch(/doing great|help|well/i);
    expect(result.speech).not.toMatch(/valid order number|didn't catch/i);
    expect(session.phase).toBe("awaiting_order_number");
  });

  it('responds warmly to "hello"', async () => {
    const session = createCallSession("CA_HELLO", "+15550001", "+15550002");
    session.phase = "awaiting_order_number";
    const result = await handleAgentTurn(session, "hello");
    expect(result.speech).toMatch(/hi|help|order|what can/i);
    expect(result.speech).not.toMatch(/valid order number|didn't catch/i);
  });

  it("brain fallback never uses robotic phrasing", () => {
    expect(softFallback("how are you")).not.toMatch(/valid order number/i);
  });
});
