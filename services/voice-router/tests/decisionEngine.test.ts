import { beforeEach, describe, expect, it } from "vitest";
import { decideRoute } from "../src/voice-router/decisionEngine.js";
import { clearAllSessions } from "../src/voice-router/sessionStore.js";

describe("decisionEngine", () => {
  beforeEach(() => {
    clearAllSessions();
  });

  it('routes "how are you" to greeting handler (not order lookup)', async () => {
    const decision = await decideRoute({
      speech: "how are you",
      callSid: "CA_GREET",
    });
    expect(decision.target).toBe("greeting");
    expect(decision.intent).toBe("greeting");
    expect(decision.responseText).toMatch(/doing well|help you/i);
    expect(decision.responseText).not.toMatch(/valid order number/i);
  });

  it('routes "hello" to greeting handler', async () => {
    const decision = await decideRoute({
      speech: "hello",
      callSid: "CA_HELLO",
    });
    expect(decision.target).toBe("greeting");
    expect(decision.intent).toBe("greeting");
  });

  it("routes numeric order input to order_lookup", async () => {
    const decision = await decideRoute({
      speech: "My order number is 456789",
      callSid: "CA111",
    });
    expect(decision.target).toBe("order_lookup");
    expect(decision.intent).toBe("order_lookup");
    expect(decision.reason).toContain("order_lookup");
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

  it("routes ambiguous speech to clarify (not main_agent)", async () => {
    const decision = await decideRoute({
      speech: "umm yeah so",
      callSid: "CA_UNKNOWN",
    });
    expect(decision.target).toBe("clarify");
    expect(decision.responseText).toBeTruthy();
  });

  it("reprompts on empty speech", async () => {
    const decision = await decideRoute({
      speech: "",
      callSid: "CA444",
    });
    expect(decision.target).toBe("clarify");
    expect(decision.reason).toBe("empty_speech_reprompt");
    expect(decision.responseText).toMatch(/didn't hear/i);
  });
});
