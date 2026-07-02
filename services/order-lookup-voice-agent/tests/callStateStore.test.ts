import { beforeEach, describe, expect, it } from "vitest";
import {
  applyDecisionToCallState,
  clearAllCallStates,
  finalizeAfterToolExecution,
  getOrCreateCallState,
  isSlotAnswerComplete,
  mergeTurnIntoCallState,
  saveCallState,
} from "../src/memory/callStateStore.js";

describe("callStateStore", () => {
  beforeEach(() => {
    clearAllCallStates();
  });

  it("persists slots across turns", () => {
    const state = getOrCreateCallState("CA_1");
    const merged = mergeTurnIntoCallState(state, {
      intent: "product",
      incomingSlots: { isbn: "9783161484100" },
    });
    saveCallState(merged);

    const reloaded = getOrCreateCallState("CA_1");
    expect(reloaded.slots.isbn).toBe("9783161484100");
    expect(reloaded.intent).toBe("product");
  });

  it("keeps product intent while awaiting slot answer", () => {
    let state = getOrCreateCallState("CA_2");
    state = applyDecisionToCallState(
      { ...state, intent: "product" },
      "ASK_QUESTION",
    );
    saveCallState(state);

    const merged = mergeTurnIntoCallState(getOrCreateCallState("CA_2"), {
      intent: "unknown",
      incomingSlots: { isbn: "9783161484100" },
    });
    expect(merged.intent).toBe("product");
    expect(merged.slots.isbn).toBe("9783161484100");
  });

  it("marks ISBN answer complete on first turn", () => {
    expect(
      isSlotAnswerComplete("none", { isbn: "9783161484100" }),
    ).toBe(true);
    expect(isSlotAnswerComplete("none", { title: "Harry Potter" })).toBe(false);
  });

  it("marks title answer complete only after prior ask", () => {
    expect(
      isSlotAnswerComplete("isbn_or_title", { title: "Harry Potter" }),
    ).toBe(true);
    expect(
      isSlotAnswerComplete("none", { title: "Harry Potter" }),
    ).toBe(false);
  });

  it("resets state after tool execution", () => {
    let state = getOrCreateCallState("CA_3");
    state = {
      ...state,
      phase: "PHASE_2",
      intent: "product",
      slots: { isbn: "9783161484100" },
      awaitingInput: "none",
    };
    saveCallState(state);

    const reset = finalizeAfterToolExecution(getOrCreateCallState("CA_3"));
    expect(reset.phase).toBe("PHASE_1");
    expect(reset.slots).toEqual({});
    expect(reset.awaitingInput).toBe("none");
    expect(reset.intent).toBe("unknown");
  });
});
