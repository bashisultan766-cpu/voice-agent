import { beforeEach, describe, expect, it } from "vitest";
import { detectEmotionalTone, shapeVoiceResponse } from "../src/agents/personalityEngine.js";
import {
  clearAllCustomerMemories,
  getOrCreateCustomerMemory,
  recordAssistantPhrase,
} from "../src/memory/customerMemoryStore.js";

describe("personalityEngine", () => {
  beforeEach(() => {
    clearAllCustomerMemories();
  });

  it("detects frustrated tone", () => {
    expect(detectEmotionalTone("this is frustrating")).toBe("frustrated");
  });

  it("strips robotic no-results phrasing", () => {
    const memory = getOrCreateCustomerMemory("CA1");
    const shaped = shapeVoiceResponse("No results found for that.", memory);
    expect(shaped).not.toMatch(/no results found/i);
    expect(shaped).toMatch(/close|couldn't find/i);
  });

  it("avoids repeating identical assistant phrases", () => {
    const memory = getOrCreateCustomerMemory("CA2");
    recordAssistantPhrase(memory, "We have that book in stock.");
    const shaped = shapeVoiceResponse("We have that book in stock.", memory);
    expect(shaped.toLowerCase()).not.toBe("we have that book in stock.");
  });
});
