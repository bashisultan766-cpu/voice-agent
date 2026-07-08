import { describe, expect, it } from "vitest";
import type { LlmAgentTurnInput } from "../src/adapters/openaiAdapter.js";

describe("LLM outage deterministic fallback", () => {
  it("uses warm greeting when OpenAI quota fails on hello", async () => {
    const { runLlmAgentTurn } = await import("../src/adapters/openaiAdapter.js");
    const { setLlmAgentTurnOverride } = await import("../src/adapters/openaiAdapter.js");

    setLlmAgentTurnOverride(async () => {
      throw new Error("429 quota exceeded");
    });

    try {
      const input: LlmAgentTurnInput = {
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

      const result = await runLlmAgentTurn(input);
      expect(result.speech).toMatch(/doing (great|well)/i);
      expect(result.speech).not.toMatch(/didn't catch/i);
    } finally {
      setLlmAgentTurnOverride(null);
    }
  });
});
