import { beforeEach, describe, expect, it } from "vitest";
import {
  applyDecisionToCallState,
  atomicMergeTurnState,
  clearAllCallStates,
  finalizeAfterToolExecution,
  getOrCreateCallState,
  isSlotAnswerComplete,
  mergeTurnIntoCallState,
  saveCallState,
  validateProductSlotState,
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

  it("validateProductSlotState blocks missing slots", () => {
    const state = getOrCreateCallState("CA_VAL");
    state.intent = "product";
    saveCallState(state);

    const result = validateProductSlotState(getOrCreateCallState("CA_VAL"), false);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("missing_slots");
  });

  it("validateProductSlotState allows ISBN immediately", () => {
    const state = getOrCreateCallState("CA_ISBN");
    saveCallState(
      mergeTurnIntoCallState(state, {
        intent: "product",
        incomingSlots: { isbn: "9783161484100" },
      }),
    );

    const result = validateProductSlotState(getOrCreateCallState("CA_ISBN"), false);
    expect(result.ready).toBe(true);
  });

  it("validateProductSlotState allows meaningful title when provided", () => {
    const state = getOrCreateCallState("CA_TITLE");
    saveCallState(
      mergeTurnIntoCallState(
        { ...state, intent: "product" },
        { intent: "product", incomingSlots: { title: "Harry Potter" } },
      ),
    );

    const result = validateProductSlotState(getOrCreateCallState("CA_TITLE"), false);
    expect(result.ready).toBe(true);
  });

  it("validateProductSlotState blocks generic title without collection", () => {
    const state = getOrCreateCallState("CA_GENERIC");
    saveCallState(
      mergeTurnIntoCallState(
        { ...state, intent: "product" },
        { intent: "product", incomingSlots: { title: "books" } },
      ),
    );

    const result = validateProductSlotState(getOrCreateCallState("CA_GENERIC"), false);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("title_needs_confirmation");
  });

  it("atomicMergeTurnState persists before validation", () => {
    const turn = atomicMergeTurnState("CA_ATOMIC", {
      intent: "product",
      incomingSlots: { isbn: "9783161484100" },
    });

    expect(turn.validation.ready).toBe(true);
    expect(getOrCreateCallState("CA_ATOMIC").slots.isbn).toBe("9783161484100");
  });
});
