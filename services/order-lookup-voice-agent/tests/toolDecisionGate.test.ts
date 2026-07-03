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

  it("returns ASK_QUESTION when product intent has no validation", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        slots: {},
        slotsCollected: false,
        validationReady: false,
      }),
    );
    expect(decision).toBe("ASK_QUESTION");
  });

  it("returns searchProductByISBN only when validation.ready", () => {
    const blocked = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        slots: { isbn: "9783161484100" },
        slotsCollected: true,
        validationReady: false,
      }),
    );
    expect(blocked).toBe("ASK_QUESTION");

    const allowed = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        slots: { isbn: "9783161484100" },
        slotsCollected: true,
        validationReady: true,
      }),
    );
    expect(allowed).toBe("searchProductByISBN");
  });

  it("returns ASK_QUESTION for title when validation not ready", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        slots: { title: "Harry Potter" },
        slotsCollected: false,
        validationReady: false,
      }),
    );
    expect(decision).toBe("ASK_QUESTION");
  });

  it("returns searchProductByTitle when validation.ready", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        phase: "PHASE_1",
        awaitingInput: "title",
        slots: { title: "Harry Potter" },
        slotsCollected: true,
        validationReady: true,
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
        validationReady: true,
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
        validationReady: true,
      }),
    );
    expect(decision).toBe("conversationOnly");
  });
});
