import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideRoute } from "../src/voice-router/decisionEngine.js";
import { clearAllSessions } from "../src/voice-router/sessionStore.js";

describe("decisionEngine safe mode", () => {
  const originalSafeMode = process.env.SAFE_MODE;

  beforeEach(() => {
    clearAllSessions();
    vi.resetModules();
  });

  afterEach(() => {
    process.env.SAFE_MODE = originalSafeMode;
    vi.resetModules();
  });

  it("routes all speech to conversation brain when SAFE_MODE=true", async () => {
    process.env.SAFE_MODE = "true";
    const { decideRoute: decideRouteSafe } = await import("../src/voice-router/decisionEngine.js");

    const decision = await decideRouteSafe({
      speech: "My order number is 456789",
      callSid: "CA_SAFE",
    });

    expect(decision.target).toBe("conversation_brain");
    expect(decision.intent).toBe("unknown");
    expect(decision.reason).toBe("safe_mode");
  });
});

describe("decisionEngine", () => {
  beforeEach(() => {
    clearAllSessions();
    process.env.SAFE_MODE = "false";
  });

  it('routes "how are you" to conversation brain (not order lookup)', async () => {
    const decision = await decideRoute({
      speech: "how are you",
      callSid: "CA_GREET",
    });
    expect(decision.target).toBe("conversation_brain");
    expect(decision.intent).toBe("greeting");
  });

  it('routes "Harry Potter book" to order-lookup product brain', async () => {
    const decision = await decideRoute({
      speech: "I want Harry Potter book",
      callSid: "CA_HP",
    });
    expect(decision.target).toBe("order_lookup");
    expect(decision.intent).toBe("product_search");
    expect(decision.reason).toContain("product_intent");
  });

  it('routes ISBN query to order-lookup product brain', async () => {
    const decision = await decideRoute({
      speech: "ISBN 9781234567890",
      callSid: "CA_ISBN",
    });
    expect(decision.target).toBe("order_lookup");
    expect(decision.intent).toBe("isbn_query");
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
