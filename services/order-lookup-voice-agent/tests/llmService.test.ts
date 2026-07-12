import { describe, expect, it } from "vitest";
import {
  classifyFollowUpIntent,
  clearLastSpokenSentence,
  ensureUniqueSpokenResponse,
  isCartModificationUtterance,
  isClosingConversationUtterance,
  isExplicitEndCallIntent,
  isExplicitGoodbyeUtterance,
  isNoWithCartCorrection,
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

  it("does not treat yes + order question as conversation end after anything else", () => {
    expect(
      isClosingConversationUtterance("yes, tell me how many items and what is the title", [
        {
          role: "assistant",
          content:
            "Would you like help with anything else on your order, or are you looking to buy a book?",
        },
      ]),
    ).toBe(false);
  });
});

describe("isClosingConversationUtterance", () => {
  it("treats explicit goodbye and okay bye as conversation end", () => {
    expect(isClosingConversationUtterance("goodbye")).toBe(true);
    expect(isClosingConversationUtterance("okay bye")).toBe(true);
  });

  it("does not treat bare thank you as conversation end", () => {
    expect(isClosingConversationUtterance("thank you")).toBe(false);
    expect(isClosingConversationUtterance("thanks")).toBe(false);
  });

  it("does not treat cart math or mind-changes as conversation end", () => {
    expect(isClosingConversationUtterance("no make it 20")).toBe(false);
    expect(isClosingConversationUtterance("add 10, minus 5")).toBe(false);
    expect(isClosingConversationUtterance("No, make it 10 copies")).toBe(false);
    expect(
      isClosingConversationUtterance("No, make it 10", [
        { role: "assistant", content: "Is there anything else I can help you with today?" },
      ]),
    ).toBe(false);
    expect(
      isClosingConversationUtterance("no", [
        { role: "assistant", content: "Is there anything else I can help you with today?" },
      ]),
    ).toBe(true);
    expect(isClosingConversationUtterance("no, I don't need more copies")).toBe(false);
  });
});

describe("isNoWithCartCorrection", () => {
  it("detects no followed by cart correction keywords", () => {
    expect(isNoWithCartCorrection("No, make it 10")).toBe(true);
    expect(isNoWithCartCorrection("no wait change that to 5 copies")).toBe(true);
    expect(isNoWithCartCorrection("no")).toBe(false);
    expect(isNoWithCartCorrection("no thank you")).toBe(false);
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
  it("blocks end_call during cart modifications", () => {
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "no make it 20",
      }),
    ).toBe(true);
  });

  it("blocks end_call during payment link confirmations", () => {
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "Yes, send me the payment link",
      }),
    ).toBe(true);
  });

  it("blocks end_call during locked cart flow unless caller explicitly closes", () => {
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "sounds good",
        session: { shoppingCart: [{ title: "Book", quantity: 1, unitPrice: "10" }] } as never,
      }),
    ).toBe(true);
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "goodbye",
        session: { shoppingCart: [{ title: "Book", quantity: 1, unitPrice: "10" }] } as never,
      }),
    ).toBe(false);
  });

  it("blocks end_call during order corrections and vague acknowledgments", () => {
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "that's wrong, the third item wasn't that price",
      }),
    ).toBe(true);
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "sounds good",
        toolExecutions: [{ tool: "get_shopify_order_status" }],
      }),
    ).toBe(true);
  });

  it("allows end_call only on explicit closing intent", () => {
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "goodbye",
      }),
    ).toBe(false);
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "no thank you",
      }),
    ).toBe(false);
    expect(
      shouldBlockPrematureEndCall({
        userMessage: "no",
        messages: [
          { role: "assistant", content: "Is there anything else I can help you with today?" },
        ],
      }),
    ).toBe(false);
  });
});

describe("isExplicitEndCallIntent", () => {
  it("detects no thank you and explicit goodbyes", () => {
    expect(isExplicitEndCallIntent("no thank you")).toBe(true);
    expect(isExplicitEndCallIntent("bye")).toBe(true);
    expect(isExplicitEndCallIntent("that's wrong")).toBe(false);
  });
});

describe("ensureUniqueSpokenResponse", () => {
  it("allows verbatim duplicate speech without rewrite oscillation", async () => {
    clearLastSpokenSentence("CA_DEDUP");
    const first = await ensureUniqueSpokenResponse("CA_DEDUP", "Your order is on the way.");
    expect(first).toBe("Your order is on the way.");
    const second = await ensureUniqueSpokenResponse(
      "CA_DEDUP",
      "Your order is on the way.",
      "repeat that",
    );
    expect(second).toBe(first);
    clearLastSpokenSentence("CA_DEDUP");
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

  it("does not treat spatial tracking repeat as repeat_order", async () => {
    await expect(classifyFollowUpIntent("please repeat after 5, 3")).resolves.toBe("other");
    await expect(classifyFollowUpIntent("what comes after 3 and 5")).resolves.toBe("other");
  });
});
