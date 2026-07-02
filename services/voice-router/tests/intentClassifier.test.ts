import { describe, expect, it } from "vitest";
import { classifyIntent } from "../src/voice-router/intentClassifier.js";
import {
  buildClarifyingResponse,
  buildGreetingResponse,
} from "../src/voice-router/handlers/greetingHandler.js";

describe("intentClassifier", () => {
  it('classifies "how are you" as greeting', async () => {
    const result = await classifyIntent("how are you");
    expect(result.intent).toBe("greeting");
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.source).toBe("regex");
  });

  it('classifies "hello" as greeting', async () => {
    const result = await classifyIntent("hello");
    expect(result.intent).toBe("greeting");
  });

  it('classifies "my order is 12345" as order_lookup', async () => {
    const result = await classifyIntent("my order is 12345");
    expect(result.intent).toBe("order_lookup");
  });

  it('classifies "where is my order" as order_lookup', async () => {
    const result = await classifyIntent("where is my order");
    expect(result.intent).toBe("order_lookup");
  });

  it('classifies refund requests as refund', async () => {
    const result = await classifyIntent("I need a refund on my order");
    expect(result.intent).toBe("refund");
  });
});

describe("greetingHandler", () => {
  it("responds warmly to how are you", () => {
    const reply = buildGreetingResponse("how are you");
    expect(reply).toMatch(/doing well/i);
    expect(reply).not.toMatch(/valid order number|didn't catch/i);
  });

  it("asks a clarifying question for unknown intent", () => {
    const reply = buildClarifyingResponse();
    expect(reply).toMatch(/order number|how can I help/i);
  });
});
