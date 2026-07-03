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

  it("preserves grounded store-not-found message", () => {
    const memory = getOrCreateCustomerMemory("CA1");
    const shaped = shapeVoiceResponse("I could not find an exact match in the system.", memory);
    expect(shaped).toBe("I could not find an exact match in the system.");
  });

  it("avoids repeating identical assistant phrases", () => {
    const memory = getOrCreateCustomerMemory("CA2");
    recordAssistantPhrase(memory, "We have that book in stock.");
    const shaped = shapeVoiceResponse("We have that book in stock.", memory);
    expect(shaped.toLowerCase()).not.toBe("we have that book in stock.");
  });
});
