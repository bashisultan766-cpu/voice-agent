import { beforeEach, describe, expect, it } from "vitest";
import {
  BRAIN_GREETING,
  createCallSession,
  handleBrainTurn,
} from "../src/agents/conversationBrain.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { useLlmAgentMock } from "./helpers/registerLlmMock.js";

useLlmAgentMock();

describe("conversationBrain", () => {
  beforeEach(() => {
    clearAllCallMemories();
  });

  it("exposes the canonical call-start greeting", () => {
    expect(BRAIN_GREETING).toMatch(/Welcome to SureShot Books/i);
    expect(BRAIN_GREETING).toMatch(/order/i);
    expect(BRAIN_GREETING).toMatch(/order number/i);
    expect(BRAIN_GREETING).not.toMatch(/I am SureShot Bookstore/i);
  });

  it('routes "hello" to order lookup on the first turn', async () => {
    const session = createCallSession("CA_BRAIN", "+1", "+2");
    const result = await handleBrainTurn(session, "hello");
    expect(result.speech).toMatch(/order number/i);
    expect(session.awaitingInput).toBe("order_number");
  });

  it('asks for order number on "where is my order"', async () => {
    const session = createCallSession("CA_ORD", "+1", "+2");
    const result = await handleBrainTurn(session, "where is my order");
    expect(result.speech).toMatch(/order number/i);
    expect(session.awaitingInput).toBe("order_number");
  });
});
