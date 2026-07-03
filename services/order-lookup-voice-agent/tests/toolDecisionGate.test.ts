import { beforeEach, describe, expect, it } from "vitest";
import {
  buildToolDecisionState,
  decideToolExecution,
} from "../src/agents/toolDecisionGate.js";
import { enablePipelineGuardForTests, resetPipelineGuard } from "../src/guards/pipelineGuard.js";

const phase1 = { phase: "PHASE_1" as const, awaitingInput: "none" as const };

describe("toolDecisionGate", () => {
  beforeEach(() => {
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
  });
  it('returns ASK_QUESTION when product intent has no slots', () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        slots: {},
        slotsCollected: false,
      }),
    );
    expect(decision).toBe("ASK_QUESTION");
  });

  it("returns searchProductByISBN when ISBN is present and collected", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        slots: { isbn: "9783161484100" },
        slotsCollected: true,
      }),
    );
    expect(decision).toBe("searchProductByISBN");
  });

  it("returns ASK_QUESTION when ISBN mentioned but not yet collected", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        phase: "PHASE_1",
        awaitingInput: "isbn",
        slots: {},
        slotsCollected: false,
      }),
    );
    expect(decision).toBe("ASK_QUESTION");
  });

  it("returns ASK_QUESTION for title on first turn without slot collection", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        slots: { title: "Harry Potter" },
        slotsCollected: false,
      }),
    );
    expect(decision).toBe("ASK_QUESTION");
  });

  it("returns searchProductByTitle after slots collected", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        phase: "PHASE_1",
        awaitingInput: "isbn_or_title",
        slots: { title: "Harry Potter" },
        slotsCollected: true,
      }),
    );
    expect(decision).toBe("searchProductByTitle");
  });

  it("returns orderLookupTool when order number present", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "order",
        ...phase1,
        slots: {},
        slotsCollected: false,
        orderNumber: "#45678",
      }),
    );
    expect(decision).toBe("orderLookupTool");
  });

  it("returns conversationOnly for general intent", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "general",
        ...phase1,
        slots: {},
        slotsCollected: false,
      }),
    );
    expect(decision).toBe("conversationOnly");
  });
});