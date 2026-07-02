import { beforeEach, describe, expect, it } from "vitest";
import { decideRoute } from "../src/voice-router/decisionEngine.js";
import { clearAllSessions } from "../src/voice-router/sessionStore.js";

describe("decisionEngine", () => {
  beforeEach(() => {
    clearAllSessions();
  });

  it('routes "how are you" to conversation brain (not order lookup)', async () => {
    const decision = await decideRoute({
      speech: "how are you",
      callSid: "CA_GREET",
    });
    expect(decision.target).toBe("conversation_brain");
    expect(decision.intent).toBe("greeting");
  });

  it('routes "hello" to conversation brain', async () => {
    const decision = await decideRoute({
      speech: "hello",
      callSid: "CA_HELLO",
    });
    expect(decision.target).toBe("conversation_brain");
    expect(decision.intent).toBe("greeting");
  });

  it("routes numeric order input to order_lookup", async () => {
    const decision = await decideRoute({
      speech: "My order number is 456789",
      callSid: "CA111",
    });
    expect(decision.target).toBe("order_lookup");
    expect(decision.intent).toBe("order_lookup");
  });

  it('routes "where is my order" to order_lookup', async () => {
    const decision = await decideRoute({
      speech: "where is my order",
      callSid: "CA222",
    });
    expect(decision.target).toBe("order_lookup");
    expect(decision.intent).toBe("order_lookup");
  });

  it("routes refund intent to order_lookup", async () => {
    const decision = await decideRoute({
      speech: "I want a refund",
      callSid: "CA_REFUND",
    });
    expect(decision.target).toBe("order_lookup");
    expect(decision.intent).toBe("refund");
  });

  it("routes ambiguous speech to conversation brain", async () => {
    const decision = await decideRoute({
      speech: "umm yeah so",
      callSid: "CA_UNKNOWN",
    });
    expect(decision.target).toBe("conversation_brain");
  });

  it("routes empty speech to conversation brain", async () => {
    const decision = await decideRoute({
      speech: "",
      callSid: "CA444",
    });
    expect(decision.target).toBe("conversation_brain");
    expect(decision.reason).toBe("empty_speech_brain");
  });
});
