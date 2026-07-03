import { beforeEach, describe, expect, it } from "vitest";
import {
  buildToolDecisionState,
  decideToolExecution,
} from "../src/agents/toolDecisionGate.js";
import { emptyProductMemory } from "../src/memory/callMemoryStore.js";
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
        productMemory: emptyProductMemory(),
        validationReady: false,
        explicitRepeat: false,
      }),
    );
    expect(decision).toBe("ASK_QUESTION");
  });

  it("returns searchProductByISBN only when validation.ready", () => {
    const blocked = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        productMemory: {
          ...emptyProductMemory(),
          isbn: "9783161484100",
          isbnCollected: true,
        },
        validationReady: false,
        explicitRepeat: false,
      }),
    );
    expect(blocked).toBe("ASK_QUESTION");

    const allowed = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        productMemory: {
          ...emptyProductMemory(),
          isbn: "9783161484100",
          isbnCollected: true,
        },
        validationReady: true,
        explicitRepeat: false,
      }),
    );
    expect(allowed).toBe("searchProductByISBN");
  });

  it("prefers ISBN over title when both are in memory", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        ...phase1,
        productMemory: {
          isbn: "9783161484100",
          title: "Harry Potter",
          isbnCollected: true,
          titleCollected: true,
        },
        validationReady: true,
        explicitRepeat: false,
      }),
    );
    expect(decision).toBe("searchProductByISBN");
  });

  it("returns searchProductByTitle when title search key is new", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        phase: "PHASE_1",
        awaitingInput: "title",
        productMemory: {
          title: "Harry Potter",
          lastSearchKey: "title:old book",
          isbnCollected: false,
          titleCollected: true,
        },
        validationReady: true,
        explicitRepeat: false,
      }),
    );
    expect(decision).toBe("searchProductByTitle");
  });

  it("returns orderLookupTool when order number present", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "order",
        ...phase1,
        productMemory: emptyProductMemory(),
        validationReady: true,
        explicitRepeat: false,
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
        productMemory: emptyProductMemory(),
        validationReady: true,
        explicitRepeat: false,
      }),
    );
    expect(decision).toBe("conversationOnly");
  });
});
