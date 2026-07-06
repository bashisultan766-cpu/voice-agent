import { describe, expect, it } from "vitest";
import {
  buildPolitePivotSpeech,
  extractPivotTopic,
  isOutOfDomainQuestion,
} from "../src/utils/domainGuard.js";
import { runLlmAgentTurnEvents } from "../src/adapters/openaiAdapter.js";
import { clearAllAgentStates } from "../src/platform/stateProjection.js";

describe("isOutOfDomainQuestion", () => {
  it("flags general knowledge and streaming questions", () => {
    expect(isOutOfDomainQuestion("Who is the president of the USA?")).toBe(true);
    expect(isOutOfDomainQuestion("How do I watch cricket live?")).toBe(true);
    expect(isOutOfDomainQuestion("Give me a recipe for pasta")).toBe(true);
    expect(isOutOfDomainQuestion("How do I watch live football streaming?")).toBe(true);
  });

  it("allows bookstore intents", () => {
    expect(isOutOfDomainQuestion("I want to check order 12345")).toBe(false);
    expect(isOutOfDomainQuestion("Do you have Harry Potter?")).toBe(false);
    expect(isOutOfDomainQuestion("ISBN 9783161484100")).toBe(false);
  });
});

describe("extractPivotTopic", () => {
  it("extracts cricket and football independently", () => {
    expect(extractPivotTopic("How do I watch cricket?")).toBe("cricket");
    expect(extractPivotTopic("How do I watch live football streaming?")).toBe("football");
  });
});

describe("buildPolitePivotSpeech", () => {
  it("uses dynamic topic injection for streaming questions", () => {
    const cricket = buildPolitePivotSpeech("How do I watch cricket?");
    const football = buildPolitePivotSpeech("How do I watch live football streaming?");

    expect(cricket).toContain("cricket");
    expect(cricket).not.toContain("football");
    expect(football).toContain("football");
    expect(football).not.toMatch(/\bcricket\b/i);
    expect(football).toMatch(/watching football/i);
  });

  it("accepts an explicit topic override", () => {
    const speech = buildPolitePivotSpeech("Tell me something random", "astronomy");
    expect(speech).toContain("astronomy");
  });
  it("refuses president question and offers history books", () => {
    const speech = buildPolitePivotSpeech("Who is the president of the USA?");
    expect(speech).toMatch(/sorry|apologize/i);
    expect(speech).toMatch(/SureShot Bookstore assistant/i);
    expect(speech).toMatch(/general knowledge/i);
    expect(speech).toMatch(/book/i);
    expect(speech).not.toMatch(/\bBiden\b|\bTrump\b|\bObama\b/i);
  });

  it("refuses cricket streaming and offers cricket books", () => {
    const speech = buildPolitePivotSpeech("How do I watch cricket?");
    expect(speech).toMatch(/sorry|apologize/i);
    expect(speech).toMatch(/cricket/i);
    expect(speech).toMatch(/catalog|search/i);
    expect(speech).not.toMatch(/youtube|stream|espn/i);
  });

  it("refuses recipes and offers cookbooks", () => {
    const speech = buildPolitePivotSpeech("Give me a recipe for lasagna");
    expect(speech).toMatch(/don't have access to recipes/i);
    expect(speech).toMatch(/cookbook/i);
  });
});

describe("runLlmAgentTurnEvents polite pivot", () => {
  it("returns polite pivot without calling Shopify tools", async () => {
    clearAllAgentStates();

    let speech = "";
    let toolCount = -1;
    for await (const event of runLlmAgentTurnEvents({
      callSid: "CA_OOD",
      userMessage: "Who is the president of the USA?",
      messages: [{ role: "user", content: "Who is the president of the USA?" }],
    })) {
      if (event.type === "result") {
        speech = event.result.speech;
        toolCount = event.result.toolExecutions.length;
      }
    }

    expect(speech).toMatch(/sorry|apologize/i);
    expect(speech).toMatch(/book/i);
    expect(speech).not.toMatch(/\bBiden\b|\bTrump\b|\bObama\b/i);
    expect(toolCount).toBe(0);
  });

  it("pivots on cricket streaming questions", async () => {
    clearAllAgentStates();

    let speech = "";
    for await (const event of runLlmAgentTurnEvents({
      callSid: "CA_CRICKET",
      userMessage: "How do I watch cricket?",
      messages: [{ role: "user", content: "How do I watch cricket?" }],
    })) {
      if (event.type === "result") speech = event.result.speech;
    }

    expect(speech).toContain("cricket");
    expect(speech).toMatch(/catalog|search/i);
    expect(speech).not.toMatch(/youtube|hotstar|stream it/i);
  });
});
