import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgendaPlanTts,
  buildAgendaTransitionTts,
  clearAllDialogueStates,
  completeCurrentAgendaItem,
  getCurrentAgendaItem,
  shouldAnnouncePlan,
  updateAgendaFromSpeech,
} from "../src/agents/dialogueManager.js";

describe("dialogueManager agenda", () => {
  afterEach(() => {
    clearAllDialogueStates();
  });

  it("builds a plan for order + product multi-intent", () => {
    const tts = buildAgendaPlanTts(["order_status", "product_search"]);
    expect(tts).toContain("both");
    expect(tts).toContain("order number");
  });

  it("queues agenda items from speech without duplicates", () => {
    const callSid = "CA_AGENDA";
    updateAgendaFromSpeech(
      callSid,
      "Hi, first I want to check my order status, and then I want to buy a book",
    );
    updateAgendaFromSpeech(callSid, "also track my order");

    const state = updateAgendaFromSpeech(callSid, "buy a book");
    expect(state.agenda).toEqual(["order_status", "product_search"]);
    expect(getCurrentAgendaItem(callSid)).toBe("order_status");
  });

  it("announces plan once for multi-intent utterances", () => {
    const callSid = "CA_PLAN";
    const speech =
      "first check my order status and then I want to buy a book";
    updateAgendaFromSpeech(callSid, speech);
    expect(shouldAnnouncePlan(callSid, speech)).toBe(true);
  });

  it("advances agenda after order completion with product bridge", () => {
    const callSid = "CA_TRANSITION";
    updateAgendaFromSpeech(callSid, "check my order and buy a book");
    completeCurrentAgendaItem(callSid);
    expect(getCurrentAgendaItem(callSid)).toBe("product_search");
    expect(buildAgendaTransitionTts("product_search")).toContain("book");
  });
});
