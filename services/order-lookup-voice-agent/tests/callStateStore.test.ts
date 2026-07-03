import { beforeEach, describe, expect, it } from "vitest";
import {
  applyDecisionToCallState,
  atomicMergeTurnState,
  clearAllCallStates,
  finalizeAfterToolExecution,
  getOrCreateCallState,
  ingestIncomingSlots,
  isSlotCollectedThisTurn,
  mergeSlotsCumulative,
  mergeTurnIntoCallState,
  resolveStickyIntent,
  saveCallState,
  validateProductSlotState,
} from "../src/memory/callStateStore.js";
import { enablePipelineGuardForTests, resetPipelineGuard } from "../src/guards/pipelineGuard.js";

describe("callStateStore", () => {
  beforeEach(() => {
    clearAllCallStates();
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
  });

  it("persists slots across turns via cumulative merge", () => {
    saveCallState({
      ...getOrCreateCallState("CA_1"),
      intent: "product",
      awaitingInput: "isbn",
      slots: { isbn: "9783161484100" },
    });

    const turn = atomicMergeTurnState("CA_1", {
      intent: "unknown",
      incomingSlots: {},
      userMessage: "one moment",
    });

    expect(turn.state.slots.isbn).toBe("9783161484100");
  });

  it("mergeSlotsCumulative normalizes ISBN and never drops existing slots", () => {
    const merged = mergeSlotsCumulative(
      { isbn: "9783161484100" },
      { title: "Harry Potter" },
    );
    expect(merged.isbn).toBe("9783161484100");
    expect(merged.title).toBe("Harry Potter");

    const unchanged = mergeSlotsCumulative(merged, {});
    expect(unchanged.isbn).toBe("9783161484100");
    expect(unchanged.title).toBe("Harry Potter");
  });

  it("keeps product intent while awaiting slot answer", () => {
    let state = getOrCreateCallState("CA_2");
    state = applyDecisionToCallState({ ...state, intent: "product" }, "ASK_QUESTION");
    saveCallState(state);

    const merged = mergeTurnIntoCallState(getOrCreateCallState("CA_2"), {
      intent: "unknown",
      incomingSlots: { isbn: "9783161484100" },
      userMessage: "9783161484100",
    });
    expect(merged.intent).toBe("product");
    expect(merged.slots.isbn).toBe("9783161484100");
  });

  it("marks ISBN collected only when awaiting isbn", () => {
    const seeded = getOrCreateCallState("CA_ISBN_FLAG");
    saveCallState({ ...seeded, intent: "product", awaitingInput: "isbn" });

    const turn = atomicMergeTurnState("CA_ISBN_FLAG", {
      intent: "product",
      incomingSlots: { isbn: "9783161484100" },
      userMessage: "9783161484100",
    });

    expect(turn.state.slotFlags.isbnCollected).toBe(true);
    expect(turn.state.awaitingInput).toBe("none");
    expect(isSlotCollectedThisTurn("isbn", turn.state)).toBe(true);
  });

  it("does not reset awaiting to isbn after ISBN is collected", () => {
    let state = getOrCreateCallState("CA_NO_REASK");
    state = mergeTurnIntoCallState(
      { ...state, intent: "product", awaitingInput: "isbn" },
      { intent: "product", incomingSlots: { isbn: "9783161484100" }, userMessage: "9783161484100" },
    );
    saveCallState(state);

    const afterAsk = applyDecisionToCallState(getOrCreateCallState("CA_NO_REASK"), "ASK_QUESTION");
    expect(afterAsk.awaitingInput).not.toBe("isbn");
    expect(afterAsk.slots.isbn).toBe("9783161484100");
    expect(afterAsk.slotFlags.isbnCollected).toBe(true);
  });

  it("marks title answer complete only after awaiting title", () => {
    const seeded = getOrCreateCallState("CA_TITLE");
    saveCallState({ ...seeded, intent: "product", awaitingInput: "title" });

    const turn = atomicMergeTurnState("CA_TITLE", {
      intent: "product",
      incomingSlots: { title: "Harry Potter" },
      userMessage: "Harry Potter",
    });

    expect(turn.state.slotFlags.titleCollected).toBe(true);
    expect(turn.validation.ready).toBe(true);
  });

  it("resets phase after tool execution but preserves session memory", () => {
    let state = getOrCreateCallState("CA_3");
    state = {
      ...state,
      phase: "PHASE_2",
      intent: "product",
      slots: { isbn: "9783161484100" },
      slotFlags: { isbnCollected: true, titleCollected: false, recommendationsCollected: false },
      awaitingInput: "none",
    };
    saveCallState(state);

    const reset = finalizeAfterToolExecution(getOrCreateCallState("CA_3"));
    expect(reset.phase).toBe("PHASE_1");
    expect(reset.slots.isbn).toBe("9783161484100");
    expect(reset.slotFlags.isbnCollected).toBe(true);
    expect(reset.intent).toBe("product");
    expect(reset.awaitingInput).toBe("none");
  });

  it("validateProductSlotState blocks missing slots", () => {
    const state = getOrCreateCallState("CA_VAL");
    state.intent = "product";
    saveCallState(state);

    const result = validateProductSlotState(getOrCreateCallState("CA_VAL"));
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("missing_slots");
  });

  it("validateProductSlotState allows ISBN when isbnCollected flag is set", () => {
    const state = getOrCreateCallState("CA_ISBN");
    saveCallState(
      mergeTurnIntoCallState(
        { ...state, intent: "product", awaitingInput: "isbn" },
        {
          intent: "product",
          incomingSlots: { isbn: "9783161484100" },
          userMessage: "9783161484100",
        },
      ),
    );

    const result = validateProductSlotState(getOrCreateCallState("CA_ISBN"));
    expect(result.ready).toBe(true);
  });

  it("validateProductSlotState blocks title without titleCollected flag", () => {
    const state = getOrCreateCallState("CA_TITLE_BLOCK");
    saveCallState(
      mergeTurnIntoCallState(
        { ...state, intent: "product" },
        { intent: "product", incomingSlots: { title: "Harry Potter" } },
      ),
    );

    const result = validateProductSlotState(getOrCreateCallState("CA_TITLE_BLOCK"));
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("title_needs_confirmation");
  });

  it("maps parsedIsbn alias to canonical isbn at ingress", () => {
    expect(ingestIncomingSlots({ parsedIsbn: "978-3-16-148410-0" })).toEqual({
      isbn: "9783161484100",
    });

    const merged = mergeSlotsCumulative({}, { parsedIsbn: "978-3-16-148410-0" });
    expect(merged.isbn).toBe("9783161484100");
  });

  it("does not downgrade a complete ISBN with partial speech", () => {
    const merged = mergeSlotsCumulative(
      { isbn: "9783161484100" },
      { isbn: "978" },
    );
    expect(merged.isbn).toBe("9783161484100");
  });

  it("keeps product intent sticky across unrelated utterances", () => {
    const base = {
      ...getOrCreateCallState("CA_STICKY"),
      intent: "product" as const,
      awaitingInput: "none" as const,
      slots: { isbn: "9783161484100" },
      slotFlags: {
        isbnCollected: true,
        titleCollected: false,
        recommendationsCollected: false,
      },
    };
    saveCallState(base);

    const merged = mergeTurnIntoCallState(base, {
      intent: "unknown",
      incomingSlots: {},
      userMessage: "okay thanks",
    });

    expect(merged.intent).toBe("product");
    expect(resolveStickyIntent(base, "unknown", "okay thanks")).toBe("product");
  });

  it("accumulates ISBN digits across multiple voice turns", () => {
    const callSid = "CA_MULTI";
    saveCallState({
      ...getOrCreateCallState(callSid),
      intent: "product",
      awaitingInput: "isbn",
    });

    atomicMergeTurnState(callSid, {
      intent: "product",
      incomingSlots: {},
      userMessage: "nine seven eight",
    });

    const turn = atomicMergeTurnState(callSid, {
      intent: "product",
      incomingSlots: {},
      userMessage: "three one six one four eight four one zero zero",
    });

    expect(turn.state.slots.isbn).toBe("9783161484100");
    expect(turn.state.slotFlags.isbnCollected).toBe(true);
    expect(turn.validation.ready).toBe(true);
  });
});
