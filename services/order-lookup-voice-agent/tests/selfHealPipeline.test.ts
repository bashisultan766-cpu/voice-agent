import { beforeEach, describe, expect, it } from "vitest";
import { emptyProductMemory } from "../src/memory/callMemoryStore.js";
import { createInitialCallState } from "../src/memory/callStateStore.js";
import {
  detectFrustrationSignal,
  detectMemoryDesync,
  evaluateSelfHeal,
  shouldForceRepeatSearch,
} from "../src/runtime/selfHealPipeline.js";
import {
  clearAllTurnHealth,
  clearApiThrottleFailures,
  recordApiThrottleFailure,
} from "../src/runtime/turnHealthMonitor.js";
import { resetShopifyCircuitBreaker } from "../src/platform/circuitBreaker.js";

describe("selfHealPipeline", () => {
  beforeEach(() => {
    clearAllTurnHealth();
    resetShopifyCircuitBreaker();
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

  it("blocks self-heal repeat search when API throttle failures recorded", () => {
    const state = createInitialCallState("HEAL_THR");
    const memory = emptyProductMemory();
    recordApiThrottleFailure("HEAL_THR");
    const evaluation = evaluateSelfHeal("HEAL_THR", "9783161484100", memory, state);
    expect(evaluation.degradedMode).toBe(true);
    expect(evaluation.shouldHeal).toBe(false);
    expect(evaluation.blockRepeatSearch).toBe(true);
    expect(shouldForceRepeatSearch(evaluation)).toBe(false);
    clearApiThrottleFailures("HEAL_THR");
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
