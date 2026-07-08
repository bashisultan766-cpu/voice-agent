import { afterEach, describe, expect, it } from "vitest";
import {
  runLlmAgentTurn,
  setLlmAgentTurnOverride,
  type LlmAgentTurnInput,
} from "../src/adapters/openaiAdapter.js";
import { buildGreetingResponse } from "../src/handlers/greetingHandler.js";
import { softFallback } from "../src/agents/conversationBrainAgent.js";

const quotaInput: LlmAgentTurnInput = {
  callSid: "CA_QUOTA",
  userMessage: "hello, how are you?",
  messages: [],
  session: {
    callSid: "CA_QUOTA",
    from: "+1",
    to: "+2",
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    greetedThisCall: true,
  },
};

describe("LLM outage deterministic fallback", () => {
  afterEach(() => {
    setLlmAgentTurnOverride(null);
  });

  it("exposes warm greeting copy without calling OpenAI", () => {
    const speech = buildGreetingResponse("hello, how are you?");
    expect(speech).toMatch(/doing (great|well)/i);
    expect(speech).not.toMatch(/didn't catch/i);
    expect(softFallback("hello")).not.toMatch(/didn't catch/i);
  });

  it("uses warm greeting when the LLM override throws (429 quota)", async () => {
    setLlmAgentTurnOverride(async () => {
      throw new Error("429 quota exceeded");
    });

    const result = await runLlmAgentTurn(quotaInput);
    expect(result.speech).toMatch(/doing (great|well)/i);
    expect(result.speech).not.toMatch(/didn't catch/i);
  });
});
