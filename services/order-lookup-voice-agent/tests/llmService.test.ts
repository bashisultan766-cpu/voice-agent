import { describe, expect, it } from "vitest";
import {
  classifyFollowUpIntent,
  isCartModificationUtterance,
  isClosingConversationUtterance,
  isExplicitGoodbyeUtterance,
  shouldBlockPrematureEndCall,
} from "../src/services/llmService.js";

describe("isExplicitGoodbyeUtterance", () => {
  it("treats explicit farewells as goodbye", () => {
    expect(isExplicitGoodbyeUtterance("goodbye")).toBe(true);
    expect(isExplicitGoodbyeUtterance("bye for now")).toBe(true);
    expect(isExplicitGoodbyeUtterance("see you later")).toBe(true);
    expect(isExplicitGoodbyeUtterance("please hang up")).toBe(true);
    expect(isExplicitGoodbyeUtterance("that's all, thanks")).toBe(true);
  });

  it("does not treat bare no as goodbye", () => {
    expect(isExplicitGoodbyeUtterance("no")).toBe(false);
    expect(isExplicitGoodbyeUtterance("no thanks")).toBe(false);
    expect(isExplicitGoodbyeUtterance("nope")).toBe(false);
    expect(isExplicitGoodbyeUtterance("no, I don't need more copies")).toBe(false);
  });

});

describe("isClosingConversationUtterance", () => {
  it("treats thank you and explicit goodbye as conversation end", () => {
    expect(isClosingConversationUtterance("thank you")).toBe(true);
    expect(isClosingConversationUtterance("okay bye")).toBe(true);
  });

  it("does not treat cart math or mind-changes as conversation end", () => {
    expect(isClosingConversationUtterance("no make it 20")).toBe(false);
    expect(isClosingConversationUtterance("add 10, minus 5")).toBe(false);
    expect(
      isClosingConversationUtterance("no", [
        { role: "assistant", content: "Is there anything else I can help you with today?" },
      ]),
    ).toBe(true);
    expect(isClosingConversationUtterance("no, I don't need more copies")).toBe(false);
  });
});

describe("isCartModificationUtterance", () => {
  it("detects rapid cart quantity changes", () => {
    expect(isCartModificationUtterance("Add 50, no make it 20")).toBe(true);
    expect(isCartModificationUtterance("minus 5 from Dad to boy")).toBe(true);
    expect(isCartModificationUtterance("remove 2 copies of the bible")).toBe(true);
  });

  it("does not flag explicit goodbyes", () => {
    expect(isCartModificationUtterance("thank you, goodbye")).toBe(false);
  });
});

describe("shouldBlockPrematureEndCall", () => {
  it("blocks when cart tools ran in the same turn", () => {
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "sounds good",
        toolExecutions: [{ tool: "add_to_cart" }],
      }),
    ).toBe(true);
  });
});

describe("classifyFollowUpIntent", () => {
  it("does not classify bare no as goodbye", async () => {
    await expect(classifyFollowUpIntent("no")).resolves.toBe("other");
    await expect(classifyFollowUpIntent("no, that's fine")).resolves.toBe("other");
  });

  it("classifies explicit goodbye", async () => {
    await expect(classifyFollowUpIntent("bye")).resolves.toBe("goodbye");
  });
});
