import { describe, expect, it } from "vitest";
import { classifyCallerIntent } from "../src/agents/intentClassifier.js";
import { buildGreetingResponse } from "../src/handlers/greetingHandler.js";
import { createCallSession, handleAgentTurn } from "../src/agents/orderAgent.js";

describe("intentClassifier", () => {
  it('classifies "how are you" as greeting', async () => {
    const result = await classifyCallerIntent("how are you");
    expect(result.intent).toBe("greeting");
  });

  it('classifies "my order is 12345" as order_lookup', async () => {
    const result = await classifyCallerIntent("my order is 12345");
    expect(result.intent).toBe("order_lookup");
  });
});

describe("greeting conversations", () => {
  it('responds warmly to "how are you" without invalid-order error', async () => {
    const session = createCallSession("CA_GREET", "+15550001", "+15550002");
    session.phase = "awaiting_order_number";
    const result = await handleAgentTurn(session, "how are you");
    expect(result.speech).toMatch(/doing well|help/i);
    expect(result.speech).not.toMatch(/valid order number|didn't catch/i);
    expect(session.phase).toBe("awaiting_order_number");
  });

  it('responds warmly to "hello"', async () => {
    const session = createCallSession("CA_HELLO", "+15550001", "+15550002");
    session.phase = "awaiting_order_number";
    const result = await handleAgentTurn(session, "hello");
    expect(result.speech).toMatch(/hey|help|order/i);
    expect(result.speech).not.toMatch(/valid order number|didn't catch/i);
  });

  it("greeting handler never mentions invalid numbers", () => {
    expect(buildGreetingResponse("how are you")).not.toMatch(/valid order number/i);
  });
});
