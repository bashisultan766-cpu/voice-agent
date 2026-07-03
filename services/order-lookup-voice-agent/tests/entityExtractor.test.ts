import { describe, expect, it } from "vitest";
import {
  extractEntities,
  extractIsbnFromStt,
  extractOrderNumberFromStt,
  extractTitleFromStt,
  normalizeAlphanumericOrderId,
  normalizeIsbnFromStt,
  normalizeSpokenNumericSequence,
} from "../src/nlp/entityExtractor.js";

describe("normalizeSpokenNumericSequence", () => {
  it("collapses spoken digit words", () => {
    expect(normalizeSpokenNumericSequence("one two three four five")).toBe("12345");
  });

  it("drops stray S between spoken digits (STT noise)", () => {
    expect(normalizeSpokenNumericSequence("one two three four S five")).toBe("12345");
  });

  it("maps O/oh to zero", () => {
    expect(normalizeSpokenNumericSequence("oh oh seven")).toBe("007");
    expect(normalizeSpokenNumericSequence("o o seven")).toBe("007");
  });

  it("maps A/ate to eight", () => {
    expect(normalizeSpokenNumericSequence("ate five")).toBe("85");
    expect(normalizeSpokenNumericSequence("a five")).toBe("85");
  });

  it("maps letter I to one in numeric context", () => {
    expect(normalizeSpokenNumericSequence("i two three")).toBe("123");
  });

  it("preserves inline digit runs", () => {
    expect(normalizeSpokenNumericSequence("order 12 34 56")).toBe("123456");
  });
});

describe("normalizeAlphanumericOrderId", () => {
  it("prefixes hash for spoken order numbers", () => {
    expect(normalizeAlphanumericOrderId("one two three four five")).toBe("#12345");
  });
});

describe("normalizeIsbnFromStt", () => {
  it("normalizes spoken ISBN digits", () => {
    const spoken =
      "nine seven eight three one six one four eight four one zero zero";
    expect(normalizeIsbnFromStt(spoken)).toBe("9783161484100");
  });
});

describe("extractOrderNumberFromStt", () => {
  it("extracts labeled order number", () => {
    expect(extractOrderNumberFromStt("my order number is 12345")).toBe("#12345");
  });

  it("extracts spoken order number", () => {
    expect(extractOrderNumberFromStt("one two three four five")).toBe("#12345");
  });

  it("extracts inline digit run", () => {
    expect(extractOrderNumberFromStt("status for 98765")).toBe("#98765");
  });
});

describe("extractTitleFromStt", () => {
  it("extracts title from looking-for phrase", () => {
    expect(extractTitleFromStt("I'm looking for The Great Gatsby")).toBe(
      "The Great Gatsby",
    );
  });

  it("returns null for order-only utterance", () => {
    expect(extractTitleFromStt("where is my order 12345")).toBeNull();
  });
});

describe("extractIsbnFromStt", () => {
  it("extracts compact ISBN-13", () => {
    expect(extractIsbnFromStt("9783161484100")).toBe("9783161484100");
  });
});

describe("extractEntities intent routing", () => {
  it("routes ISBN when digits present", () => {
    const result = extractEntities("ISBN 9783161484100");
    expect(result.intent).toBe("isbn_search");
    expect(result.isbn).toBe("9783161484100");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("routes order status from tracking phrase", () => {
    const result = extractEntities("track my order 54321");
    expect(result.intent).toBe("order_status");
    expect(result.orderNumber).toBe("#54321");
  });

  it("routes title search from book phrase", () => {
    const result = extractEntities("do you have Harry Potter");
    expect(result.intent).toBe("title_search");
    expect(result.title).toBeTruthy();
  });

  it("respects awaiting slot context", () => {
    const result = extractEntities("one two three four five", {
      awaitingSlot: "order_number",
    });
    expect(result.orderNumber).toBe("#12345");
    expect(result.slotType).toBe("order_number");
  });
});
