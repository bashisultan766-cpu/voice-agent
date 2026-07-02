import { beforeEach, describe, expect, it } from "vitest";
import { decideRoute } from "../src/voice-router/decisionEngine.js";
import { clearAllSessions } from "../src/voice-router/sessionStore.js";

describe("decisionEngine", () => {
  beforeEach(() => {
    clearAllSessions();
  });

  it("routes numeric order input to order_lookup", async () => {
    const decision = await decideRoute({
      speech: "My order number is 456789",
      callSid: "CA111",
    });
    expect(decision.target).toBe("order_lookup");
    expect(decision.reason).toBe("order_number_pattern");
  });

  it('routes "where is my order" to order_lookup', async () => {
    const decision = await decideRoute({
      speech: "where is my order",
      callSid: "CA222",
    });
    expect(decision.target).toBe("order_lookup");
    expect(decision.reason).toBe("order_intent_keywords");
  });

  it("routes general catalog question to main_agent", async () => {
    const decision = await decideRoute({
      speech: "I want to buy a cookbook for my brother in prison",
      callSid: "CA333",
    });
    expect(decision.target).toBe("main_agent");
  });

  it("defaults empty speech to main_agent", async () => {
    const decision = await decideRoute({
      speech: "",
      callSid: "CA444",
    });
    expect(decision.target).toBe("main_agent");
    expect(decision.reason).toBe("empty_speech_default_main");
  });
});
