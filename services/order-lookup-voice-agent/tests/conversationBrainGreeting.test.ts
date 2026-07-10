import { beforeEach, describe, expect, it } from "vitest";
import { softFallback } from "../src/agents/conversationBrainAgent.js";
import { createCallSession, handleAgentTurn } from "../src/agents/orderAgent.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";

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
