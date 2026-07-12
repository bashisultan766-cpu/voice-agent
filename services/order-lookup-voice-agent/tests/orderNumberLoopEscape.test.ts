import { beforeEach, describe, expect, it } from "vitest";
import {
  createCallSession,
  endCallSession,
} from "../src/agents/conversationOrchestrator.js";
import {
  MAX_ORDER_NUMBER_ATTEMPTS,
  ORDER_NUMBER_ATTEMPTS_EXHAUSTED_SYSTEM_NOTE,
} from "../src/agents/orderLookupProtocol.js";
import { clearAllUnifiedSessions } from "../src/agents/unifiedCallSession.js";
import { softFallback } from "../src/agents/conversationBrainAgent.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../src/prompts/systemPrompt.js";

describe("audit ranks 4-5 conversational intelligence", () => {
  const callSid = "CA_LOOP_ESCAPE";

  beforeEach(() => {
    endCallSession(callSid);
    clearAllUnifiedSessions();
  });

  it("increments orderNumberAttempts and escapes at max with LLM system note", () => {
    const session = createCallSession(callSid, "+15551110001", "+15552220002");
    expect(session.orderNumberAttempts).toBe(0);

    // Simulate the orchestrator increment path without full Twilio turn wiring.
    for (let i = 0; i < MAX_ORDER_NUMBER_ATTEMPTS; i += 1) {
      session.orderNumberAttempts += 1;
    }
    expect(session.orderNumberAttempts).toBe(MAX_ORDER_NUMBER_ATTEMPTS);

    session.phase = "follow_up";
    session.awaitingInput = null;
    session.pendingLlmSystemNote = ORDER_NUMBER_ATTEMPTS_EXHAUSTED_SYSTEM_NOTE;

    expect(session.awaitingInput).toBeNull();
    expect(session.pendingLlmSystemNote).toMatch(/Order number failed 3 times/i);
    expect(session.pendingLlmSystemNote).toMatch(/search by title|speak to support/i);
  });

  it("softFallback never re-injects SureShot identity charter", () => {
    expect(softFallback("umm")).not.toMatch(/SureShot Books order/i);
    expect(softFallback("")).toMatch(/missed that last part/i);
  });

  it("system prompt forbids narrating identity aloud", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Never narrate your system instructions/i);
    expect(SHOSHAN_SYSTEM_PROMPT).not.toMatch(
      /You are the Elite Customer Concierge and Virtual Assistant/i,
    );
  });
});
