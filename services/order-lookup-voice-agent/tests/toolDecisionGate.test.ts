import { describe, expect, it } from "vitest";
import {
  buildToolDecisionState,
  decideToolExecution,
} from "../src/agents/toolDecisionGate.js";

describe("toolDecisionGate", () => {
  it('returns ASK_QUESTION when product intent has no slots', () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        slots: {},
        slotsCollected: false,
      }),
    );
    expect(decision).toBe("ASK_QUESTION");
  });

  it("returns searchProductByISBN when ISBN is present", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
        slots: { isbn: "9783161484100" },
        slotsCollected: false,
      }),
    );
    expect(decision).toBe("searchProductByISBN");
  });

  it("returns ASK_QUESTION for title on first turn without slot collection", () => {
    const decision = decideToolExecution(
      buildToolDecisionState({
        intent: "product",
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
        slots: {},
        slotsCollected: false,
      }),
    );
    expect(decision).toBe("conversationOnly");
  });
});
