import { beforeEach, describe, expect, it } from "vitest";
import {
  shapeBrainResponse,
  softFallback,
} from "../src/agents/conversationBrainAgent.js";
import {
  appendAssistantMessage,
  appendUserMessage,
  clearAllCallMemories,
  getOrCreateMemory,
  memoryCount,
} from "../src/memory/callMemoryStore.js";

describe("callMemoryStore", () => {
  beforeEach(() => {
    clearAllCallMemories();
  });

  it("stores last messages per callSid", () => {
    const memory = getOrCreateMemory("CA100");
    appendUserMessage(memory, "how are you");
    appendAssistantMessage(memory, "Doing great!");
    expect(memory.messages).toHaveLength(2);
    expect(memoryCount()).toBe(1);
  });

  it("trims to 10 messages", () => {
    const memory = getOrCreateMemory("CA101");
    for (let i = 0; i < 12; i++) {
      appendUserMessage(memory, `msg ${i}`);
    }
    expect(memory.messages.length).toBeLessThanOrEqual(10);
  });
});

describe("conversationBrainAgent shaping", () => {
  beforeEach(() => {
    clearAllCallMemories();
  });

  it("soft fallback for how are you is conversational", () => {
    expect(softFallback("how are you")).toMatch(/doing great|help/i);
    expect(softFallback("how are you")).not.toMatch(/valid order number|didn't catch/i);
  });

  it("soft fallback for what do you do is brief without identity dump", () => {
    expect(softFallback("what do you do")).toMatch(/look up|order|book/i);
    expect(softFallback("what do you do")).not.toMatch(/SureShot Books order/i);
  });

  it("default soft fallback is neutral filler", () => {
    expect(softFallback("asdf")).toMatch(/try that again|help/i);
    expect(softFallback("asdf")).not.toMatch(/I'm here to help with your SureShot/i);
  });

  it("strips robotic phrases", () => {
    const memory = getOrCreateMemory("CA200");
    appendUserMessage(memory, "hello");
    const shaped = shapeBrainResponse("I didn't catch a valid order number.", memory);
    expect(shaped).not.toMatch(/didn't catch|valid order number/i);
  });

  it("limits to two sentences", () => {
    const memory = getOrCreateMemory("CA201");
    appendUserMessage(memory, "hi");
    const shaped = shapeBrainResponse(
      "First sentence here. Second sentence here. Third sentence should be cut.",
      memory,
    );
    const sentences = shaped.split(/(?<=[.!?])\s+/);
    expect(sentences.length).toBeLessThanOrEqual(2);
  });
});
