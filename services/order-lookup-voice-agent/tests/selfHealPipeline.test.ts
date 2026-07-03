import { beforeEach, describe, expect, it } from "vitest";
import { emptyProductMemory } from "../src/memory/callMemoryStore.js";
import { createInitialCallState } from "../src/memory/callStateStore.js";
import {
  detectFrustrationSignal,
  detectMemoryDesync,
  evaluateSelfHeal,
  shouldForceRepeatSearch,
} from "../src/runtime/selfHealPipeline.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";

describe("selfHealPipeline", () => {
  beforeEach(() => {
    clearAllTurnHealth();
  });

  it("detects frustration signals", () => {
    expect(detectFrustrationSignal("why do you keep asking me")).toBe(true);
    expect(detectFrustrationSignal("Harry Potter")).toBe(false);
  });

  it("detects memory desync between slots and session memory", () => {
    const state = createInitialCallState("HEAL_1");
    state.slots.isbn = "9783161484100";
    state.slotFlags.isbnCollected = true;
    const memory = {
      ...emptyProductMemory(),
      isbn: "9780000000000",
      isbnCollected: true,
    };
    expect(detectMemoryDesync(state, memory)).toBe(true);
  });

  it("triggers self-heal on repeated utterance", () => {
    const state = createInitialCallState("HEAL_2");
    const memory = emptyProductMemory();
    evaluateSelfHeal("HEAL_2", "9783161484100", memory, state);
    const second = evaluateSelfHeal("HEAL_2", "9783161484100", memory, state);
    expect(second.shouldHeal).toBe(true);
    expect(second.reasons).toContain("repeated_utterance");
    expect(shouldForceRepeatSearch(second)).toBe(true);
  });
});
