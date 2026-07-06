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
    expect(BRAIN_GREETING).toMatch(/SureShot Bookstore/i);
    expect(BRAIN_GREETING).toMatch(/How can I assist you today/i);
    expect(BRAIN_GREETING).not.toMatch(/order number|ISBN/i);
  });

  it('responds naturally to "hello" without demanding order number', async () => {
    const session = createCallSession("CA_BRAIN", "+1", "+2");
    session.phase = "awaiting_order_number";
    const result = await handleBrainTurn(session, "hello");
    expect(result.speech).toMatch(/help|Sureshot|hi/i);
    expect(result.speech).not.toMatch(/provide your order|valid order number/i);
  });

  it('asks for order number on "where is my order"', async () => {
    const session = createCallSession("CA_ORD", "+1", "+2");
    const result = await handleBrainTurn(session, "where is my order");
    expect(result.speech).toMatch(/order number/i);
    expect(session.awaitingInput).toBeNull();
  });
});
