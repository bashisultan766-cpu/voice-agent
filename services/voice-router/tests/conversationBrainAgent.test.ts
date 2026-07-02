import { describe, expect, it } from "vitest";
import {
  shapeBrainResponse,
  softFallback,
} from "../src/voice-router/agents/conversationBrainAgent.js";
import { appendUserMessage, getOrCreateMemory } from "../src/memory/callMemoryStore.js";

describe("router conversationBrainAgent", () => {
  it("responds naturally to greetings via fallback", () => {
    expect(softFallback("how are you")).toMatch(/doing great/i);
  });

  it("never uses robotic invalid-order phrasing", () => {
    const memory = getOrCreateMemory("CA300");
    appendUserMessage(memory, "hello");
    const shaped = shapeBrainResponse("Please provide your order number.", memory);
    expect(shaped).not.toMatch(/please provide your order number/i);
  });
});
